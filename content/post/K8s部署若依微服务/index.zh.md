---
title: "K8s中部署若依微服务"
date: 2026-05-29
lastmod: 2026-05-29
description: "在 Kubernetes 集群中完整部署若依微服务（RuoYi-Cloud）的实践记录，包含基础设施部署、Nacos 配置、Docker 镜像构建及 K8s 编排的全流程"
categories:
    - Kubernetes
    - 微服务
    - 搭建
tags:
    - k8s
    - 若依
    - RuoYi
    - Spring Cloud
    - Docker
---

# K8s 中部署若依微服务

## 整体架构

```
                    【 外部访问流量 】
                           │
                           ▼
              ┌─────────────────────────────────┐
              │      NodePort (各服务端口)        │
              └────────────┬────────────────────┘
                           │
              ┌────────────▼────────────┐
              │   ruoyi-ui (Nginx 80)   │  -- 前端页面，反向代理 /prod-api/ → gateway
              │   NodePort 30081        │
              └────────────┬────────────┘
                           │ /prod-api/**
                           ▼
              ┌─────────────────────────┐
              │   ruoyi-gateway (8080)   │  -- 网关：路由分发、鉴权、验证码、Sentinel
              │   NodePort 30080         │
              └────────────┬────────────┘
                           │
            ┌──────────────┼──────────────┬──────────────┐
            ▼              ▼              ▼              ▼
     ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐
     │auth(9200) │  │system(9201)│ │ gen(9202)  │  │file(9300) │ ... (其他微服务)
     └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘
           │              │              │              │
           └──────────────┴──────┬───────┴──────────────┘
                                 │ (内部通信与数据存储)
                                 ▼
   ┌─────────────────────────────────────────────────────────────────┐
   │ 基础设施层 (StatefulSet / Deployment)                             │
   │ ├─ Nacos (注册/配置中心)   ├─ MySQL (数据存储)    ├─ Redis (缓存)   │
   │ ├─ Minio (对象存储)       ├─ Sentinel (流控限流)                   │
   └─────────────────────────────────────────────────────────────────┘
```

## 环境与集群信息

| 主机 | IP | 角色 |
|------|-----|------|
| k8s-master | 192.168.20.126 | K8s 控制平面 |
| k8s-node01 | 192.168.20.127 | 工作节点（运行所有业务 Pod） |
| k8s-node02 | 192.168.20.128 | 工作节点 |
| docker-builder | 192.168.20.125 | Docker 打包机 + Harbor 仓库 |

> 所有虚拟机用户 root，密码 1。
> 由于使用本地 hostPath 持久化，所有有状态服务（MySQL/Redis/Nacos/Minio）通过 nodeAffinity 固定在 **k8s-node01** 上。

---

## 一、准备工作：创建本地挂载目录

在 **k8s-node01**（192.168.20.127）上执行：

```bash
mkdir -p /data/k8s/ruoyi/{mysql,redis,nacos,minio/data,minio/config}
chmod -R 777 /data/k8s/ruoyi/
```

---

## 二、创建命名空间

创建 `ruoyi-env.yaml`：

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: ruoyi
```

```bash
kubectl apply -f ruoyi-env.yaml
```

---

## 三、部署基础设施

### 3.1 MySQL

创建 `mysql.yaml`：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ruoyi-mysql
  namespace: ruoyi
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ruoyi-mysql
  template:
    metadata:
      labels:
        app: ruoyi-mysql
    spec:
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: kubernetes.io/hostname
                operator: In
                values:
                - k8s-node01
      containers:
      - name: mysql
        image: mysql:8.0.33
        env:
        - name: MYSQL_ROOT_PASSWORD
          value: "ruoyi123"
        ports:
        - containerPort: 3306
          name: mysqlport
        volumeMounts:
        - name: mysql-data
          mountPath: /var/lib/mysql
      volumes:
      - name: mysql-data
        hostPath:
          path: /data/k8s/ruoyi/mysql
          type: Directory
---
apiVersion: v1
kind: Service
metadata:
  name: ry-db-svc
  namespace: ruoyi
spec:
  ports:
  - port: 3306
    targetPort: 3306
    nodePort: 32306
  selector:
    app: ruoyi-mysql
  type: NodePort
```

> ⚠️ 注意：Service 名称为 `ry-db-svc`，这是 Nacos 和微服务中引用的数据库地址。

```bash
kubectl apply -f mysql.yaml
```

**导入数据库**：

使用 Navicat 等工具通过 `192.168.20.127:32306` 连接 MySQL（密码 `ruoyi123`），创建 `ruoyi` 数据库并导入 SQL：

```sql
CREATE DATABASE ruoyi CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

导入若依项目 `sql/` 目录下的全部 4 个 SQL 文件。

### 3.2 Redis

创建 `redis.yaml`：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ruoyi-redis
  namespace: ruoyi
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ruoyi-redis
  template:
    metadata:
      labels:
        app: ruoyi-redis
    spec:
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: kubernetes.io/hostname
                operator: In
                values:
                - k8s-node01
      containers:
      - name: redis
        image: redis:7.0-alpine
        command: ["redis-server", "--appendonly", "yes", "--requirepass", "ruoyi123"]
        ports:
        - containerPort: 6379
          name: redisport
        volumeMounts:
        - name: redis-data
          mountPath: /data
      volumes:
      - name: redis-data
        hostPath:
          path: /data/k8s/ruoyi/redis
          type: Directory
---
apiVersion: v1
kind: Service
metadata:
  name: redis-svc
  namespace: ruoyi
spec:
  ports:
  - port: 6379
    targetPort: 6379
  selector:
    app: ruoyi-redis
```

```bash
kubectl apply -f redis.yaml
```

### 3.3 Nacos（注册中心 + 配置中心）

创建 `nacos.yaml`：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ruoyi-nacos
  namespace: ruoyi
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ruoyi-nacos
  template:
    metadata:
      labels:
        app: ruoyi-nacos
    spec:
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: kubernetes.io/hostname
                operator: In
                values:
                - k8s-node01
      containers:
      - name: nacos
        image: nacos/nacos-server:v3.1.2
        env:
        - name: MODE
          value: "standalone"
        - name: SPRING_DATASOURCE_PLATFORM
          value: "mysql"
        - name: MYSQL_SERVICE_HOST
          value: "ry-db-svc.ruoyi.svc.cluster.local"
        - name: MYSQL_SERVICE_PORT
          value: "3306"
        - name: MYSQL_SERVICE_DB_NAME
          value: "ruoyi"
        - name: MYSQL_SERVICE_USER
          value: "root"
        - name: MYSQL_SERVICE_PASSWORD
          value: "ruoyi123"
        - name: MYSQL_SERVICE_DB_PARAM
          value: "characterEncoding=utf8&connectTimeout=5000&socketTimeout=5000&autoReconnect=true&useUnicode=true&useSSL=false&serverTimezone=Asia/Shanghai&allowPublicKeyRetrieval=true"
        # Nacos 3.x 鉴权配置
        - name: NACOS_AUTH_ENABLE
          value: "true"
        - name: NACOS_AUTH_IDENTITY_KEY
          value: "ruoyi"
        - name: NACOS_AUTH_IDENTITY_VALUE
          value: "ruoyi_secret"
        - name: NACOS_AUTH_TOKEN
          value: "SecretKey01234567890123456789012345678901234567890123456789"
        ports:
        - containerPort: 8080
          name: nacosport
        - containerPort: 9080
          name: grpcport
        volumeMounts:
        - name: nacos-logs
          mountPath: /home/nacos/logs
      volumes:
      - name: nacos-logs
        hostPath:
          path: /data/k8s/ruoyi/nacos
          type: Directory
---
apiVersion: v1
kind: Service
metadata:
  name: nacos-svc
  namespace: ruoyi
spec:
  ports:
  - port: 8080
    name: http
    targetPort: 8080
    nodePort: 30848
  - port: 8848
    name: client-api
    targetPort: 8848
    nodePort: 31884
  - port: 9848
    name: grpc
    targetPort: 9848
    nodePort: 31848
  - port: 9849
    name: grpc-cluster
    targetPort: 9849
    nodePort: 31849
  selector:
    app: ruoyi-nacos
  type: NodePort
```

```bash
kubectl apply -f nacos.yaml
```

访问控制台：`http://192.168.20.127:30848/nacos/`  
登录账号/密码：`nacos` / `nacos`

> 注意：Nacos API 端口是 8848（映射为 NodePort 31884），配置管理及服务发现通过此端口通信。

### 3.4 Minio（对象存储）

创建 `minio.yaml`：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ruoyi-minio
  namespace: ruoyi
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ruoyi-minio
  template:
    metadata:
      labels:
        app: ruoyi-minio
    spec:
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: kubernetes.io/hostname
                operator: In
                values:
                - k8s-node01
      containers:
      - name: minio
        image: quay.io/minio/minio:RELEASE.2025-06-13T11-33-47Z
        args:
        - server
        - /data
        - --console-address
        - :9001
        env:
        - name: MINIO_ROOT_USER
          value: "minioadmin"
        - name: MINIO_ROOT_PASSWORD
          value: "minioadmin"
        ports:
        - containerPort: 9000
          name: api
        - containerPort: 9001
          name: console
        volumeMounts:
        - name: minio-data
          mountPath: /data
      volumes:
      - name: minio-data
        hostPath:
          path: /data/k8s/ruoyi/minio
          type: DirectoryOrCreate
---
apiVersion: v1
kind: Service
metadata:
  name: minio-svc
  namespace: ruoyi
spec:
  ports:
  - port: 9000
    name: api
    targetPort: 9000
    nodePort: 30900
  - port: 9001
    name: console
    targetPort: 9001
    nodePort: 30901
  selector:
    app: ruoyi-minio
  type: NodePort
```

```bash
kubectl apply -f minio.yaml
```

访问控制台：`http://192.168.20.127:30901`（账号：`minioadmin` / `minioadmin`）

### 3.5 Sentinel Dashboard（流控）

创建 `sentinel.yaml`：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ruoyi-sentinel
  namespace: ruoyi
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ruoyi-sentinel
  template:
    metadata:
      labels:
        app: ruoyi-sentinel
    spec:
      containers:
      - name: sentinel
        image: bladex/sentinel-dashboard:latest
        ports:
        - containerPort: 8858
          name: authport
---
apiVersion: v1
kind: Service
metadata:
  name: sentinel-svc
  namespace: ruoyi
spec:
  ports:
  - port: 8858
    targetPort: 8858
    nodePort: 30858
  selector:
    app: ruoyi-sentinel
  type: NodePort
```

```bash
kubectl apply -f sentinel.yaml
```

访问控制台：`http://192.168.20.127:30858`

---

## 四、Nacos 配置中心设置

在所有微服务启动前，需要在 Nacos 中先创建好对应的配置。

### 4.1 通用配置：`application-dev.yml`

```yaml
spring:
  autoconfigure:
    exclude: com.alibaba.druid.spring.boot.autoconfigure.DruidDataSourceAutoConfigure,org.springframework.boot.micrometer.metrics.autoconfigure.system.SystemMetricsAutoConfiguration

# feign 配置
feign:
  sentinel:
    enabled: true
  okhttp:
    enabled: true
  httpclient:
    enabled: false
  client:
    config:
      default:
        connectTimeout: 10000
        readTimeout: 10000
  compression:
    request:
      enabled: true
      min-request-size: 8192
    response:
      enabled: true

# 暴露监控端点
management:
  endpoints:
    web:
      exposure:
        include: '*'
  metrics:
    binders:
      processor:
        enabled: false
```

### 4.2 网关配置：`ruoyi-gateway-dev.yml`

```yaml
spring:
  data:
    redis:
      host: redis-svc.ruoyi.svc.cluster.local
      port: 6379
      password: ruoyi123
  redis:
    host: redis-svc.ruoyi.svc.cluster.local
    port: 6379
    password: ruoyi123
  cloud:
    gateway:
      server:
        webflux:                            # ⚠️ 必须使用 server.webflux 前缀（Spring Cloud Gateway 5.x）
          discovery:
            locator:
              lowerCaseServiceId: true
              enabled: true
          routes:
            # 认证中心
            - id: ruoyi-auth
              uri: lb://ruoyi-auth
              predicates:
                - Path=/auth/**
              filters:
                - name: CacheRequestBody
                  args:
                    bodyClass: java.lang.String
                - ValidateCodeFilter
                - StripPrefix=1
            # 代码生成
            - id: ruoyi-gen
              uri: lb://ruoyi-gen
              predicates:
                - Path=/code/**
              filters:
                - StripPrefix=1
            # 定时任务
            - id: ruoyi-job
              uri: lb://ruoyi-job
              predicates:
                - Path=/schedule/**
              filters:
                - StripPrefix=1
            # 系统模块
            - id: ruoyi-system
              uri: lb://ruoyi-system
              predicates:
                - Path=/system/**
              filters:
                - StripPrefix=1
            # 文件服务
            - id: ruoyi-file
              uri: lb://ruoyi-file
              predicates:
                - Path=/file/**
              filters:
                - StripPrefix=1

# 安全配置
security:
  captcha:
    enabled: true
    type: math
  xss:
    enabled: true
    excludeUrls:
      - /system/notice
  ignore:
    whites:
      - /auth/logout
      - /auth/login
      - /auth/register
      - /*/v2/api-docs
      - /*/v3/api-docs
      - /csrf
```

> ⚠️ **注意事项**：
> 1. **属性前缀**：新版本 Spring Cloud Gateway（5.x）使用 `spring.cloud.gateway.server.webflux` 前缀，而非旧版的 `spring.cloud.gateway`。如果不使用正确前缀，路由配置虽然能加载到 Spring 环境中，但无法被 `GatewayProperties` 绑定识别，所有路由将返回 404。
> 2. **CacheRequestBody 参数**：`CacheRequestBody` 过滤器必须指定 `bodyClass: java.lang.String`，否则启动时会报 `bodyClass must not be null`。

### 4.3 Auth 配置：`ruoyi-auth-dev.yml`

```yaml
spring:
  data:
    redis:
      host: redis-svc.ruoyi.svc.cluster.local
      port: 6379
      password: ruoyi123
  redis:
    host: redis-svc.ruoyi.svc.cluster.local
    port: 6379
    password: ruoyi123
```

### 4.4 System 配置：`ruoyi-system-dev.yml`

```yaml
spring:
  datasource:
    druid:
      url: jdbc:mysql://ry-db-svc.ruoyi.svc.cluster.local:3306/ruoyi?useUnicode=true&characterEncoding=utf8&zeroDateTimeBehavior=convertToNull&useSSL=false&serverTimezone=GMT%2B8&allowPublicKeyRetrieval=true
      username: root
      password: ruoyi123
```

### 4.5 File 配置：`ruoyi-file-dev.yml`

```yaml
# Minio配置
minio:
  url: http://minio-svc.ruoyi.svc.cluster.local:9000
  accessKey: minioadmin
  secretKey: minioadmin
  bucketName: ruoyi
```

---

## 五、修改引导配置（源码级）

在 Docker 打包机上，修改各模块的 `bootstrap.yml`，使它们指向 K8s 集群内的 Nacos。

### 5.1 Gateway

```yaml
server:
  port: 8080

spring:
  application:
    name: ruoyi-gateway
  profiles:
    active: dev
  cloud:
    nacos:
      username: nacos
      password: nacos
      discovery:
        server-addr: nacos-svc.ruoyi.svc.cluster.local:8848
      config:
        server-addr: nacos-svc.ruoyi.svc.cluster.local:8848
    sentinel:
      eager: true
      transport:
        dashboard: sentinel-svc.ruoyi.svc.cluster.local:8718
  config:
    file-extension: yml
    import:
      - nacos:application-${spring.profiles.active}.${spring.config.file-extension}
      - nacos:${spring.application.name}-${spring.profiles.active}.${spring.config.file-extension}
```

### 5.2 Auth / System / Job / Gen / File

这些模块的 `bootstrap.yml` 结构相同，仅 `server.port` 和 `spring.application.name` 不同：

| 模块 | server.port |
|------|-------------|
| auth | 9200 |
| system | 9201 |
| job | 9203 |
| gen | 9202 |
| file | 9300 |

模板：

```yaml
server:
  port: <对应端口>

spring:
  application:
    name: <对应模块名>
  profiles:
    active: dev
  cloud:
    nacos:
      username: nacos
      password: nacos
      discovery:
        server-addr: nacos-svc.ruoyi.svc.cluster.local:8848
      config:
        server-addr: nacos-svc.ruoyi.svc.cluster.local:8848
  config:
    file-extension: yml
    import:
      - nacos:application-${spring.profiles.active}.${spring.config.file-extension}
      - nacos:${spring.application.name}-${spring.profiles.active}.${spring.config.file-extension}
```

### 5.3 File 模块额外修改

由于 file 模块同时依赖 Local 和 Minio 实现，需要将 Minio 设为默认实现，在类上添加 `@Primary` 注解。

---

## 六、Docker 镜像构建与推送

### 6.1 Dockerfile

在每个微服务模块目录下创建 Dockerfile：

```dockerfile
FROM openjdk:17-jdk-alpine

RUN ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && echo 'Asia/Shanghai' > /etc/timezone

WORKDIR /app
VOLUME /tmp

COPY target/*.jar app.jar

EXPOSE 8080

ENTRYPOINT ["java", "-Djava.security.egd=file:/dev/./urandom", "-jar", "app.jar", "--spring.profiles.active=dev"]
```

### 6.2 构建与推送脚本

```bash
#!/bin/bash

set -e

# Harbor 仓库地址
REGISTRY="www.chenyang-helloworld.top/ruoyi"
TAG="v1.0.0"

# 需要打包的模块 (目录:镜像名)
MODULES=(
  "ruoyi-gateway:ruoyi-gateway"
  "ruoyi-auth:ruoyi-auth"
  "ruoyi-modules/ruoyi-system:ruoyi-system"
  "ruoyi-modules/ruoyi-job:ruoyi-job"
  "ruoyi-modules/ruoyi-gen:ruoyi-gen"
  "ruoyi-modules/ruoyi-file:ruoyi-file"
)

echo "============ Maven 编译打包 ============"
mvn clean package -DskipTests

echo "============ 构建 & 推送 Docker 镜像 ============"
for item in "${MODULES[@]}"; do
    DIR_PATH="${item%%:*}"
    IMAGE_NAME="${item##*:}"

    echo ">>> 处理: ${IMAGE_NAME} (${DIR_PATH})"

    cd ${DIR_PATH}
    docker build -t ${IMAGE_NAME}:${TAG} .
    docker tag ${IMAGE_NAME}:${TAG} ${REGISTRY}/${IMAGE_NAME}:${TAG}
    docker push ${REGISTRY}/${IMAGE_NAME}:${TAG}
    docker rmi ${REGISTRY}/${IMAGE_NAME}:${TAG}
    cd - > /dev/null
done

echo "============ 全部完成 ============"
```

---

## 七、K8s 部署编排

### 7.1 网关：`ruoyi-gateway.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ruoyi-gateway
  namespace: ruoyi
  labels:
    app: ruoyi-gateway
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ruoyi-gateway
  template:
    metadata:
      labels:
        app: ruoyi-gateway
    spec:
      imagePullSecrets:
        - name: harbor-secret
      nodeSelector:
        kubernetes.io/hostname: k8s-node01
      containers:
        - name: ruoyi-gateway
          image: www.chenyang-helloworld.top/ruoyi/ruoyi-gateway:v1.0.0
          imagePullPolicy: Always
          ports:
            - containerPort: 8080
          env:
            - name: JAVA_OPTS
              value: "-Xms256m -Xmx512m"
            - name: SPRING_DATA_REDIS_HOST
              value: redis-svc.ruoyi.svc.cluster.local
            - name: SPRING_DATA_REDIS_PORT
              value: "6379"
            - name: SPRING_DATA_REDIS_PASSWORD
              value: ruoyi123
---
apiVersion: v1
kind: Service
metadata:
  name: ruoyi-gateway
  namespace: ruoyi
  labels:
    app: ruoyi-gateway
spec:
  type: NodePort
  ports:
    - port: 8080
      targetPort: 8080
      nodePort: 30080
  selector:
    app: ruoyi-gateway
```

### 7.2 认证模块：`ruoyi-auth.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ruoyi-auth
  namespace: ruoyi
  labels:
    app: ruoyi-auth
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ruoyi-auth
  template:
    metadata:
      labels:
        app: ruoyi-auth
    spec:
      imagePullSecrets:
        - name: harbor-secret
      nodeSelector:
        kubernetes.io/hostname: k8s-node01
      containers:
        - name: ruoyi-auth
          image: www.chenyang-helloworld.top/ruoyi/ruoyi-auth:v1.0.0
          imagePullPolicy: Always
          ports:
            - containerPort: 9200
          env:
            - name: JAVA_OPTS
              value: "-Xms256m -Xmx512m"
            - name: SPRING_DATA_REDIS_HOST
              value: redis-svc.ruoyi.svc.cluster.local
            - name: SPRING_DATA_REDIS_PORT
              value: "6379"
            - name: SPRING_DATA_REDIS_PASSWORD
              value: ruoyi123
---
apiVersion: v1
kind: Service
metadata:
  name: ruoyi-auth
  namespace: ruoyi
  labels:
    app: ruoyi-auth
spec:
  type: ClusterIP
  ports:
    - port: 9200
      targetPort: 9200
  selector:
    app: ruoyi-auth
```

### 7.3 系统核心模块：`ruoyi-system.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ruoyi-system
  namespace: ruoyi
  labels:
    app: ruoyi-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ruoyi-system
  template:
    metadata:
      labels:
        app: ruoyi-system
    spec:
      imagePullSecrets:
        - name: harbor-secret
      nodeSelector:
        kubernetes.io/hostname: k8s-node01
      containers:
        - name: ruoyi-system
          image: www.chenyang-helloworld.top/ruoyi/ruoyi-system:v1.0.0
          imagePullPolicy: Always
          ports:
            - containerPort: 9201
          env:
            - name: JAVA_OPTS
              value: "-Xms512m -Xmx1024m"
---
apiVersion: v1
kind: Service
metadata:
  name: ruoyi-system
  namespace: ruoyi
  labels:
    app: ruoyi-system
spec:
  type: ClusterIP
  ports:
    - port: 9201
      targetPort: 9201
  selector:
    app: ruoyi-system
```

### 7.4 前端 UI：`ruoyi-ui.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ruoyi-ui
  namespace: ruoyi
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ruoyi-ui
  template:
    metadata:
      labels:
        app: ruoyi-ui
    spec:
      nodeSelector:
        kubernetes.io/hostname: k8s-node01
      containers:
      - name: nginx
        image: nginx:1.25-alpine
        ports:
        - containerPort: 80
        volumeMounts:
        - name: dist
          mountPath: /usr/share/nginx/html
          readOnly: true
        - name: nginx-conf
          mountPath: /etc/nginx/conf.d/default.conf
          readOnly: true
          subPath: default.conf
      volumes:
      - name: dist
        hostPath:
          path: /data/k8s/ruoyi/ui/dist
          type: Directory
      - name: nginx-conf
        configMap:
          name: ruoyi-ui-nginx-conf
---
apiVersion: v1
kind: Service
metadata:
  name: ruoyi-ui
  namespace: ruoyi
spec:
  type: NodePort
  ports:
  - port: 80
    targetPort: 80
    nodePort: 30081
  selector:
    app: ruoyi-ui
```

#### Nginx ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ruoyi-ui-nginx-conf
  namespace: ruoyi
data:
  default.conf: |
    server {
      listen 80;
      server_name _;
      charset utf-8;
      root /usr/share/nginx/html;
      index index.html index.htm;
      client_max_body_size 100m;

      location / {
        try_files $uri $uri/ /index.html;
      }

      location /prod-api/ {
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_pass http://ruoyi-gateway.ruoyi.svc.cluster.local:8080/;
      }
    }
```

### 7.5 一键部署

```bash
kubectl apply -f ruoyi-system.yaml
kubectl apply -f ruoyi-auth.yaml
kubectl apply -f ruoyi-gateway.yaml
kubectl apply -f ruoyi-job.yaml
kubectl apply -f ruoyi-gen.yaml
kubectl apply -f ruoyi-file.yaml
kubectl apply -f ruoyi-ui.yaml
```

---

## 八、服务访问汇总

| 服务 | 访问地址 | 说明 |
|------|---------|------|
| 前端登录页 | http://192.168.20.127:30081 | 若依管理界面 |
| 网关 | http://192.168.20.127:30080 | Gateway API 入口 |
| Nacos 控制台 | http://192.168.20.127:30848/nacos/ | 注册中心 & 配置中心（nacos/nacos） |
| Sentinel | http://192.168.20.127:30858 | 流控控制台 |
| Minio Console | http://192.168.20.127:30901 | 管理后台（minioadmin/minioadmin） |
| MySQL | 192.168.20.127:32306 | 数据库（root/ruoyi123） |

---

## 九、常见问题排查

### 9.1 登录时报 404 "No static resource auth/login"

**原因**：Gateway 的 `spring.cloud.gateway.*` 路由配置属性前缀不匹配。

新版本 Spring Cloud Gateway（5.x）使用 **`spring.cloud.gateway.server.webflux`** 作为配置前缀，而非旧版的 `spring.cloud.gateway`。

**修复**：在 Nacos 中将配置前缀改为新版本格式，然后重启 gateway：

```bash
kubectl rollout restart -n ruoyi deploy/ruoyi-gateway
```

### 9.2 Gateway 报 "bodyClass must not be null"

**原因**：`CacheRequestBody` 过滤器缺少 `bodyClass` 参数。

**修复**：将 `- CacheRequestBody` 改为带参数的形式：
```yaml
filters:
  - name: CacheRequestBody
    args:
      bodyClass: java.lang.String
```

### 9.3 验证 Gateway 路由

```bash
# 测试验证码接口
curl http://192.168.20.127:30080/code

# 测试登录接口
curl -X POST http://192.168.20.127:30080/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'
```

### 9.4 查看各服务日志

```bash
# 网关
kubectl logs -n ruoyi deploy/ruoyi-gateway -f

# Auth
kubectl logs -n ruoyi deploy/ruoyi-auth -f

# 查看 gateway 健康状态
kubectl exec -n ruoyi deploy/ruoyi-gateway -- \
  wget -q -O - http://127.0.0.1:8080/actuator/health
```

---

## 十、注意事项

1. **镜像拉取密钥**：从私有 Harbor 拉取镜像需要创建 `harbor-secret`：
   ```bash
   kubectl create secret docker-registry harbor-secret \
     -n ruoyi \
     --docker-server=www.chenyang-helloworld.top \
     --docker-username=<你的Harbor账号> \
     --docker-password=<你的Harbor密码>
   ```

2. **节点绑定**：所有有状态服务（MySQL/Redis/Nacos/Minio）通过 `nodeSelector` 绑定到 `k8s-node01`，确保数据持久化不漂移。

3. **Nacos 配置更新**：修改 Nacos 中的配置后，对应服务需要重启才能生效。

4. **Auth 服务不需要数据库**：auth 模块排除了 `DataSourceAutoConfiguration`，只做认证逻辑。

5. **健康检查**：建议为每个 Deployment 添加 `livenessProbe` 和 `readinessProbe`，确保 K8s 能正确处理 Pod 异常。
