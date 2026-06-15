---
title: mall-swarm K8S 完整部署指南
date: 2026-06-15
lastmod: 2026-06-15
description: k8s中的最小调度单元pod
image: 
categories:		# 文章外标签
    - Kubernetes
    - 笔记
tags:			# 文章内标签
    - k8s
    - test
---

# mall-swarm K8S 完整部署指南

> 基于阿里云 ECS + k3s + Docker Compose 的 mall-swarm 微服务项目部署实战。

---

## 架构总览

```
┌─ ECS-01 (2C8G, CentOS 7.9) ────────────┐    ┌─ ECS-02 (4C8G, CentOS 7.9) ────────────────┐
│  IP: 101.37.34.6 / 172.22.111.32       │    │  IP: 47.99.180.47 / 172.22.111.31          │
│                                        │    │                                            │
│  Docker Compose:                       │    │  k3s (v1.28.13+k3s1):                      │
│  ┌────────┐ ┌────────┐ ┌────────────┐  │    │  ┌───────────┐ ┌───────────┐ ┌──────────┐  │
│  │ MySQL  │ │ Redis  │ │ Nacos      │  │    │  │ Gateway   │ │ Admin     │ │ Auth     │  │
│  │ 5.7    │ │ 7.x    │ │ 2.1.0      │  │    │  │ 8201:30201│ │ 8080      │ │ 8401     │  │
│  │ 3306   │ │ 6379   │ │ 8848       │  │    │  └───────────┘ └───────────┘ └──────────┘  │
│  └────────┘ └────────┘ └────────────┘  │    │  ┌───────────┐ ┌───────────┐ ┌──────────┐  │
│  ┌────────┐ ┌────────┐ ┌────────────┐  │    │  │ Portal    │ │ Search    │ │ Monitor  │  │
│  │ Mongo  │ │ ES     │ │ RabbitMQ   │  │    │  │ 8085      │ │ 8081      │ │ 8101     │  │
│  │ 4.x    │ │ 7.17.3 │ │ 3.9        │  │    │  └───────────┘ └───────────┘ └──────────┘  │
│  │ 27017  │ │ 9200   │ │ 5672/15672 │  │    │                                            │
│  └────────┘ └────────┘ └────────────┘  │    │   Nginx: 101.37.34.6:80 → admin 前端       │
│  ┌────────┐                            │    └────────────────────────────────────────────┘
│  │ Nginx  │                            │
│  │ 80     │                            │     <── 阿里云内网 172.22.0.0/16 -->
│  └────────┘                            │
└────────────────────────────────────────┘
```

---

## 前置准备

### 服务器

|             | ECS-01（基础服务）                   | ECS-02（K8S 应用）           |
| ----------- | ------------------------------------ | ---------------------------- |
| 购买方式    | 按量付费                             | 免费试用                     |
| 规格        | 2C8G                                 | 4C8G                         |
| 系统        | CentOS 7.9                           | CentOS 7.9                   |
| 磁盘        | 系统 40G + 数据 100G                 | 系统 40G                     |
| 地域/可用区 | 华东1 杭州 J                         | 华东1 杭州 J（**必须相同**） |
| 安全组      | 同一安全组 `sg-bp12lr66o6bfw34dwim5` |                              |

### 安全组入方向规则

| 端口  | 来源          | 用途                 |
| ----- | ------------- | -------------------- |
| 22    | 0.0.0.0/0     | SSH                  |
| 80    | 0.0.0.0/0     | Nginx / 前端         |
| 443   | 0.0.0.0/0     | HTTPS                |
| 2080  | 0.0.0.0/0     | Nginx 代理           |
| 3306  | 172.22.0.0/16 | MySQL（仅内网！）    |
| 6379  | 172.22.0.0/16 | Redis（仅内网！）    |
| 8848  | 0.0.0.0/0     | Nacos                |
| 9200  | 172.22.0.0/16 | ES（仅内网！）       |
| 27017 | 172.22.0.0/16 | MongoDB（仅内网！）  |
| 5672  | 172.22.0.0/16 | RabbitMQ（仅内网！） |
| 15672 | 0.0.0.0/0     | RabbitMQ 管理        |
| 30201 | 0.0.0.0/0     | Gateway API          |
| 6443  | 0.0.0.0/0     | k3s API（远程管理）  |

> 🔴 **安全红线**：MySQL(3306)、Redis(6379)、MongoDB(27017)、ES(9200) 这四个端口**绝对不能开放 0.0.0.0/0**。来源限制为你的 VPC 内网段 `172.22.0.0/16`。

### 出方向规则

保持默认即可（允许所有出方向流量）。

## Phase 1：服务器初始化（两台）

```bash
# 设置主机名
# ECS-01: hostnamectl set-hostname mall-base
# ECS-02: hostnamectl set-hostname mall-k8s

# 关闭 SELinux + 防火墙（学习环境简化）
setenforce 0
sed -i 's/^SELINUX=enforcing$/SELINUX=disabled/' /etc/selinux/config
systemctl stop firewalld && systemctl disable firewalld

# 配置阿里云镜像源（加速下载）
mv /etc/yum.repos.d/CentOS-Base.repo /etc/yum.repos.d/CentOS-Base.repo.bak 2>/dev/null
curl -o /etc/yum.repos.d/CentOS-Base.repo https://mirrors.aliyun.com/repo/Centos-7.repo
yum makecache

# 安装基础工具
yum install -y wget curl vim net-tools telnet unzip git lrzsz

# 配置 hosts（替换为自己的ip）
cat >> /etc/hosts << EOF
172.22.111.32 mall-base
172.22.111.31 mall-k8s
EOF

# ECS-01 挂载数据盘（本地部署无需设置）
mkfs.ext4 /dev/vdb
mkdir -p /mydata
mount /dev/vdb /mydata
echo '/dev/vdb  /mydata  ext4  defaults  0  0' >> /etc/fstab
```

---

## Phase 2：ECS-01 部署依赖服务

### 目标

在 **ECS-01**（`101.37.34.6` / `172.22.111.32`）上用 Docker Compose 部署 mall-swarm 所需的 9 个依赖服务。

---

### 依赖服务一览

| 服务          | 镜像                        | 端口         | 说明                     |
| ------------- | --------------------------- | ------------ | ------------------------ |
| MySQL         | `mysql:5.7`                 | 3306         | 主数据库，密码 root/root |
| Redis         | `redis:7`                   | 6379         | 缓存                     |
| MongoDB       | `mongo:4`                   | 27017        | 文档存储（portal 用）    |
| RabbitMQ      | `rabbitmq:3.9-management`   | 5672 / 15672 | 消息队列                 |
| Elasticsearch | `elasticsearch:7.17.3`      | 9200 / 9300  | 搜索引擎                 |
| Logstash      | `logstash:7.17.3`           | 4560-4563    | 日志收集                 |
| Kibana        | `kibana:7.17.3`             | 5601         | ES 可视化                |
| Nacos         | `nacos/nacos-server:v2.1.0` | 8848         | 注册中心 + 配置中心      |
| Nginx         | `nginx:1.22`                | 80           | 反向代理（后续配置）     |

### 在 ECS-01 上安装 Docker

> ⚠️ 以下命令全部在 **ECS-01** 上执行。

#### 安装 Docker

```bash
# 卸载旧版本（如果有）
yum remove -y docker docker-client docker-client-latest docker-common docker-latest \
              docker-latest-logrotate docker-logrotate docker-engine

# 安装依赖
yum install -y yum-utils device-mapper-persistent-data lvm2

# 添加阿里云 Docker 镜像源
yum-config-manager --add-repo https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo

# 安装 Docker
yum install -y docker-ce docker-ce-cli containerd.io

# 启动 Docker
systemctl start docker
systemctl enable docker

# 验证
docker --version
```

#### 配置 Docker 镜像加速

```bash
mkdir -p /etc/docker
cat > /etc/docker/daemon.json << 'EOF'
{
  "registry-mirrors": ["https://docker.m.daocloud.io"],
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "100m",
    "max-file": "3"
  }
}
EOF

systemctl daemon-reload
systemctl restart docker
```

> 如果 daocloud 也不通，下面的命令可以测试当前可用的镜像源：
>
> ```bash
> for url in "https://docker.m.daocloud.io" "https://registry.cn-hangzhou.aliyuncs.com" "https://dockerproxy.com" "https://mirror.baidubce.com"; do
> echo -n "$url => "
> curl -s --connect-timeout 3 "$url/v2/" > /dev/null && echo "通" || echo "不通"
> done
> ```

#### 安装 Docker Compose

```bash
# GitHub 和 daocloud 从国内可能不通，使用 pip 安装最稳妥
yum install -y python3 python3-pip
pip3 install --upgrade pip
pip3 install docker-compose -i https://mirrors.aliyun.com/pypi/simple/

# 验证（忽略 Python 3.6 的 CryptographyDeprecationWarning）
docker-compose --version
```

> ⚠️ 如果 `docker-compose --version` 有 Python 版本警告，不影响使用。CentOS 7 自带 Python 3.6。

---

### 准备目录和配置文件

#### 创建数据目录

```bash
# 在 ECS-01 上执行（全部建在数据盘 /mydata 下）
mkdir -p /mydata/mysql/data/db
mkdir -p /mydata/mysql/data/conf
mkdir -p /mydata/mysql/log

mkdir -p /mydata/redis/data

mkdir -p /mydata/nginx/conf/conf.d
mkdir -p /mydata/nginx/html
mkdir -p /mydata/nginx/log

mkdir -p /mydata/rabbitmq/data
mkdir -p /mydata/rabbitmq/log

mkdir -p /mydata/elasticsearch/plugins
mkdir -p /mydata/elasticsearch/data

mkdir -p /mydata/logstash

mkdir -p /mydata/mongo/db
```

#### 创建 logstash 配置文件

```bash
cat > /mydata/logstash/logstash.conf << 'EOF'
input {
  tcp {
    mode => "server"
    host => "0.0.0.0"
    port => 4560
    codec => json_lines
    type => "debug"
  }
  tcp {
    mode => "server"
    host => "0.0.0.0"
    port => 4561
    codec => json_lines
    type => "error"
  }
  tcp {
    mode => "server"
    host => "0.0.0.0"
    port => 4562
    codec => json_lines
    type => "business"
  }
  tcp {
    mode => "server"
    host => "0.0.0.0"
    port => 4563
    codec => json_lines
    type => "record"
  }
}
filter{
  if [type] == "record" {
    mutate {
      remove_field => "port"
      remove_field => "host"
      remove_field => "@version"
    }
    json {
      source => "message"
      remove_field => ["message"]
    }
  }
}
output {
  elasticsearch {
    hosts => "es:9200"
    index => "mall-%{type}-%{+YYYY.MM.dd}"
  }
}
EOF
```

#### 创建 Nginx 基础配置

```bash
cat > /mydata/nginx/conf/nginx.conf << 'EOF'
user  nginx;
worker_processes  1;

error_log  /var/log/nginx/error.log warn;
pid        /var/run/nginx.pid;

events {
    worker_connections  1024;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;

    log_format  main  '$remote_addr - $remote_user [$time_local] "$request" '
                      '$status $body_bytes_sent "$http_referer" '
                      '"$http_user_agent" "$http_x_forwarded_for"';

    access_log  /var/log/nginx/access.log  main;

    sendfile        on;
    keepalive_timeout  65;

    server {
        listen       80;
        server_name  localhost;

        location / {
            root   /usr/share/nginx/html;
            index  index.html index.htm;
        }

        error_page   500 502 503 504  /50x.html;
        location = /50x.html {
            root   /usr/share/nginx/html;
        }
    }
}
EOF
```

#### 创建 docker-compose-env.yml

```bash
cat > /mydata/docker-compose-env.yml << 'EOF'
version: '3'
services:
  mysql:
    image: mysql:5.7
    container_name: mysql
    command: mysqld --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci
    restart: always
    environment:
      MYSQL_ROOT_PASSWORD: root
    ports:
      - 3306:3306
    volumes:
      - /mydata/mysql/data/db:/var/lib/mysql
      - /mydata/mysql/data/conf:/etc/mysql/conf.d
      - /mydata/mysql/log:/var/log/mysql
  redis:
    image: redis:7
    container_name: redis
    command: redis-server --appendonly yes
    volumes:
      - /mydata/redis/data:/data
    ports:
      - 6379:6379
  nginx:
    image: nginx:1.22
    container_name: nginx
    volumes:
      - /mydata/nginx/conf/nginx.conf:/etc/nginx/nginx.conf #只挂主配置文件
      - /mydata/nginx/conf/conf.d:/etc/nginx/conf.d #额外配置目录
      - /mydata/nginx/html:/usr/share/nginx/html #静态资源根目录挂载
      - /mydata/nginx/log:/var/log/nginx #日志文件挂载
    ports:
      - 80:80
  rabbitmq:
    image: rabbitmq:3.9-management
    container_name: rabbitmq
    volumes:
      - /mydata/rabbitmq/data:/var/lib/rabbitmq
      - /mydata/rabbitmq/log:/var/log/rabbitmq
    ports:
      - 5672:5672
      - 15672:15672
  elasticsearch:
    image: elasticsearch:7.17.3
    container_name: elasticsearch
    user: root
    environment:
      - "cluster.name=elasticsearch"
      - "discovery.type=single-node"
      - "ES_JAVA_OPTS=-Xms512m -Xmx512m"
    volumes:
      - /mydata/elasticsearch/plugins:/usr/share/elasticsearch/plugins
      - /mydata/elasticsearch/data:/usr/share/elasticsearch/data
    ports:
      - 9200:9200
      - 9300:9300
  logstash:
    image: logstash:7.17.3
    container_name: logstash
    environment:
      - TZ=Asia/Shanghai
    volumes:
      - /mydata/logstash/logstash.conf:/usr/share/logstash/pipeline/logstash.conf
    depends_on:
      - elasticsearch
    links:
      - elasticsearch:es
    ports:
      - 4560:4560
      - 4561:4561
      - 4562:4562
      - 4563:4563
  kibana:
    image: kibana:7.17.3
    container_name: kibana
    links:
      - elasticsearch:es
    depends_on:
      - elasticsearch
    environment:
      - "elasticsearch.hosts=http://es:9200"
    ports:
      - 5601:5601
  mongo:
    image: mongo:4
    container_name: mongo
    volumes:
      - /mydata/mongo/db:/data/db
    ports:
      - 27017:27017
  nacos-registry:
    image: nacos/nacos-server:v2.1.0
    container_name: nacos-registry
    environment:
      - "MODE=standalone"
    ports:
      - 8848:8848
EOF
```

---

### ⚠️ 启动前必备 — 修复权限和文件

> 跳过此步会导致 Elasticsearch、RabbitMQ、Nginx 启动失败。

#### 修复 Elasticsearch 数据目录权限

```bash
# ES 容器内部运行用户 uid:gid = 1000:1000
# 宿主机创建的数据目录默认是 root 所有，必须 chown
chown -R 1000:1000 /mydata/elasticsearch/data
chown -R 1000:1000 /mydata/elasticsearch/plugins
```

#### 修复 RabbitMQ 日志目录权限

```bash
# RabbitMQ 容器内部运行用户 uid:gid = 999:999
chown -R 999:999 /mydata/rabbitmq/log
```

#### 修复 Nginx — 复制容器内原生文件

```bash
# 不能把 /mydata/nginx/conf 整个目录挂载到 /etc/nginx，会覆盖掉 mime.types 等系统文件
# 改用单个文件挂载后，需要确保宿主机配置目录结构正确

# 创建一个临时 nginx 容器，从里面复制出必需的文件
docker create --name nginx-tmp nginx:1.22
docker cp nginx-tmp:/etc/nginx/mime.types /mydata/nginx/conf/
docker cp nginx-tmp:/etc/nginx/fastcgi_params /mydata/nginx/conf/
docker cp nginx-tmp:/etc/nginx/conf.d /mydata/nginx/conf/
docker rm nginx-tmp

# 验证目录结构
ls -la /mydata/nginx/conf/
# 应有: nginx.conf, mime.types, fastcgi_params, conf.d/
```

---

### 启动所有服务

```bash
# 在 ECS-01 上执行
cd /mydata
docker-compose -f docker-compose-env.yml up -d
```

> ⚠️ **注意**：首次启动会从 Docker Hub 拉取镜像，会比较慢（约 10-20 分钟）。如果下载失败，检查镜像加速配置是否正确。

---

### 验证所有服务

```bash
# 查看所有容器运行状态（全部应为 Up）
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

# 查看是否有启动失败的
docker ps -a | grep -v Up | grep -v NAMES
```

逐一验证：

```bash
# MySQL
docker exec mysql mysql -uroot -proot -e "SELECT 1"

# Redis
docker exec redis redis-cli PING

# Elasticsearch
curl http://localhost:9200

# Nacos（等 30 秒启动）
curl http://localhost:8848/nacos

# RabbitMQ 管理页
curl http://localhost:15672

# MongoDB
docker exec mongo mongo --eval "db.version()"

# Kibana
curl http://localhost:5601
```

---

## Phase 3 — K8S 集群搭建（k3s）

### 目标

在 **ECS-02**（`47.99.180.47` / `172.22.111.31`）上安装 k3s 轻量级 K8S 集群。

---

### 环境说明

| 项目         | 值                     |
| ------------ | ---------------------- |
| 操作系统     | CentOS 7.9 64位        |
| 规格         | 4核8G                  |
| k3s 版本     | v1.28.13+k3s1          |
| 容器运行时   | containerd（k3s 内置） |
| Service CIDR | 10.43.0.0/16（默认）   |
| Pod CIDR     | 10.42.0.0/16（默认）   |

> k3s 默认 CIDR 不与 VPC 网段 `172.22.0.0/16` 冲突，无需调整。

---

### ECS-02 基础准备

> ⚠️ 以下命令全部在 **ECS-02**（`ssh root@47.99.180.47`）上执行。

```bash
# 配置 hosts
cat >> /etc/hosts << 'EOF'
172.22.111.32 mall-base
172.22.111.31 mall-k8s
EOF

# 确认与 ECS-01 互通
ping -c 2 172.22.111.32
```

---

### 安装 k3s

> ⚠️ GitHub 从阿里云 ECS 访问会被墙，官方安装脚本无法直接下载二进制。需要分两步走。

#### 本地下载 k3s 二进制

在你自己的 **Windows 电脑**上，用浏览器下载：

```
https://github.com/k3s-io/k3s/releases/download/v1.28.13+k3s1/k3s
```

> 约 62MB。

#### 上传到 ECS-02

在 Windows 终端（PowerShell/Git Bash）中，切换到下载目录执行：

```bash
scp k3s root@47.99.180.47:/usr/local/bin/
```

#### 安装 k3s

回到 SSH 终端（ECS-02）：

```bash
# 验证上传成功
ls -la /usr/local/bin/k3s
chmod +x /usr/local/bin/k3s
k3s --version

# 下载安装脚本（脚本很小，不依赖 GitHub）
curl -sfL https://rancher-mirror.rancher.cn/k3s/k3s-install.sh -o /tmp/k3s-install.sh

# 跳过下载，使用已上传的二进制安装
INSTALL_K3S_SKIP_DOWNLOAD=true bash /tmp/k3s-install.sh

# 验证
kubectl get nodes
```

预期输出：

```
NAME       STATUS   ROLES                  AGE   VERSION
mall-k8s   Ready    control-plane,master   10s   v1.28.13+k3s1
```

---

### ⚠️ 关键修复 — containerd 镜像加速

k3s 内置 containerd 作为容器运行时，不走 Docker 配置，需要单独设置镜像源。

#### 配置 containerd 镜像

```bash
cat > /etc/rancher/k3s/registries.yaml << 'EOF'
mirrors:
  docker.io:
    endpoint:
      - "https://docker.m.daocloud.io"
EOF

systemctl restart k3s
```

#### 安装 Docker（辅助用途）

containerd 的 daocloud 镜像源可能缺失 `rancher/` 命名空间。需要 Docker 来手动拉取并导入镜像：

```bash
yum install -y yum-utils
yum-config-manager --add-repo https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo
yum install -y docker-ce docker-ce-cli containerd.io

cat > /etc/docker/daemon.json << 'EOF'
{
  "registry-mirrors": ["https://docker.m.daocloud.io"],
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "100m",
    "max-file": "3"
  }
}
EOF

systemctl start docker
systemctl enable docker
```

#### 手动导入 traefik 镜像

重启 k3s 后，如果 traefik Pod 状态是 `ErrImagePull`：

```bash
# 用 Docker 拉取（daocloud 全镜像支持更好）
docker pull rancher/mirrored-library-traefik:2.10.7

# 导入到 k3s 的 containerd
docker save rancher/mirrored-library-traefik:2.10.7 | k3s ctr images import -

# 等 Pod 自动重试
sleep 10
kubectl get pods -A
```

> 后续其他 `rancher/` 命名空间的镜像也可能需要同样处理：`docker pull` → `docker save | k3s ctr images import -`

#### 验证所有系统 Pod 就绪

```bash
kubectl get pods -A
```

预期所有 Pod 状态为 `Running` 或 `Completed`。

---

### 配置 kubectl

```bash
echo 'export KUBECONFIG=/etc/rancher/k3s/k3s.yaml' >> ~/.bashrc
source ~/.bashrc

# 验证
kubectl cluster-info
kubectl get pods -n kube-system
```

> 如果从本地开发机管理 k3s，把 `/etc/rancher/k3s/k3s.yaml` 拷贝到本地，将 server 地址改成 `https://47.99.180.47:6443` 即可（需开放安全组 6443 端口）。

---

### 创建微服务日志目录

```bash
mkdir -p /mydata/app/mall-admin/logs
mkdir -p /mydata/app/mall-gateway/logs
mkdir -p /mydata/app/mall-auth/logs
mkdir -p /mydata/app/mall-portal/logs
mkdir -p /mydata/app/mall-search/logs
mkdir -p /mydata/app/mall-monitor/logs
```

---

## Phase 4 — 获取 Docker 镜像

### 目标

将 mall-swarm 微服务镜像导入到 ECS-02 的 k3s 集群中，为后续 K8S 部署做准备。

---

### 微服务镜像清单

| 服务         | 镜像                                    | 端口 |
| ------------ | --------------------------------------- | ---- |
| mall-gateway | `macrodocker/mall-gateway:1.0-SNAPSHOT` | 8201 |
| mall-auth    | `macrodocker/mall-auth:1.0-SNAPSHOT`    | 8401 |
| mall-admin   | `macrodocker/mall-admin:1.0-SNAPSHOT`   | 8080 |
| mall-portal  | `macrodocker/mall-portal:1.0-SNAPSHOT`  | 8085 |
| mall-search  | `macrodocker/mall-search:1.0-SNAPSHOT`  | 8081 |
| mall-monitor | `macrodocker/mall-monitor:1.0-SNAPSHOT` | 8101 |

---

### 拉取镜像并导入 k3s

> ⚠️ 在 **ECS-02** 上执行。

#### 配置 Docker 镜像源

daocloud 镜像源只代理官方镜像（`library/*`），不代理用户命名空间（`macrodocker/*`）。需要换用支持全量代理的源。

先用以下命令测试可用的镜像源：

```bash
for url in "https://dockerproxy.net" "https://docker.1panel.live" "https://hub.rat.dev"; do
  echo -n "$url => "
  curl -s --connect-timeout 5 "$url/v2/" > /dev/null && echo "通" || echo "不通"
done
```

选一个能通的，写入 Docker 配置：

```bash
cat > /etc/docker/daemon.json << 'EOF'
{
  "registry-mirrors": ["https://docker.1panel.live"],
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "100m",
    "max-file": "3"
  }
}
EOF

systemctl restart docker
```

> 如果某个源拉取很慢，换其他能通的试试。`docker.1panel.live` 和 `hub.rat.dev` 通常是较好的备选。

#### 拉取所有微服务镜像

```bash
docker pull macrodocker/mall-gateway:1.0-SNAPSHOT
docker pull macrodocker/mall-auth:1.0-SNAPSHOT
docker pull macrodocker/mall-monitor:1.0-SNAPSHOT
docker pull macrodocker/mall-admin:1.0-SNAPSHOT
docker pull macrodocker/mall-portal:1.0-SNAPSHOT
docker pull macrodocker/mall-search:1.0-SNAPSHOT
```

```
### 1.1 验证镜像

```bash
docker images | grep macrodocker
```

预期输出：

```
macrodocker/mall-gateway   1.0-SNAPSHOT   xxx   xxx MB
macrodocker/mall-auth      1.0-SNAPSHOT   xxx   xxx MB
macrodocker/mall-monitor   1.0-SNAPSHOT   xxx   xxx MB
macrodocker/mall-admin     1.0-SNAPSHOT   xxx   xxx MB
macrodocker/mall-portal    1.0-SNAPSHOT   xxx   xxx MB
macrodocker/mall-search    1.0-SNAPSHOT   xxx   xxx MB
```

#### 导入到 k3s containerd

```bash
# 一次性批量导入
for img in \
  macrodocker/mall-gateway:1.0-SNAPSHOT \
  macrodocker/mall-auth:1.0-SNAPSHOT \
  macrodocker/mall-monitor:1.0-SNAPSHOT \
  macrodocker/mall-admin:1.0-SNAPSHOT \
  macrodocker/mall-portal:1.0-SNAPSHOT \
  macrodocker/mall-search:1.0-SNAPSHOT; do
  echo "Importing $img ..."
  docker save $img | k3s ctr images import -
done

# 验证 k3s 已识别镜像
k3s ctr images ls | grep macrodocker
```

---

## Phase 5 — Nacos 配置导入与修改

### 目标

将微服务配置导入 Nacos，并修改连接地址为 ECS-01 的实际 IP。

---

### 访问 Nacos

打开浏览器访问：**http://101.37.34.6:8848/nacos**

```
默认账号：nacos
默认密码：nacos
```

---

### 配置说明

原配置使用 Docker Compose 容器名（`db`、`redis`、`mongo`、`rabbit`、`es`），需要改为 ECS-01 内网 IP `172.22.111.32`。

| 原地址                                                  | 改后                                                       |
| ------------------------------------------------------- | ---------------------------------------------------------- |
| `db` / `mongo` / `redis` / `rabbit` / `es` / `logstash` | `172.22.111.32`                                            |
| `192.168.3.101:8848`（Nacos）                           | `172.22.111.32:8848`                                       |
| `jwk-set-uri: http://192.168.3.101:8201/...`            | `http://mall-gateway-service:8201/mall-auth/rsa/publicKey` |
| `minio endpoint: http://192.168.3.101:9090`             | 暂无 MinIO，保留占位                                       |

---

### 创建配置

逐个在 Nacos 中创建以下 4 个配置（**每个微服务只需要 prod 配置**）。

#### mall-admin-prod.yaml

**Data ID**: `mall-admin-prod.yaml`
**Group**: `DEFAULT_GROUP`
**配置格式**: YAML
**配置内容**:

```yaml
spring:
  datasource:
    url: jdbc:mysql://172.22.111.32:3306/mall?useUnicode=true&characterEncoding=utf-8&serverTimezone=Asia/Shanghai&useSSL=false
    username: root
    password: root
  redis:
    host: 172.22.111.32
    database: 0
    port: 6379
    password:
logging:
  file:
    path: /var/logs
  level:
    root: info
    com.macro.mall: info
logstash:
  host: 172.22.111.32
```

#### mall-gateway-prod.yaml

**Data ID**: `mall-gateway-prod.yaml`
**Group**: `DEFAULT_GROUP`
**配置格式**: YAML

```yaml
spring:
  redis:
    host: 172.22.111.32
    database: 0
    port: 6379
    password:
  security:
    oauth2:
      resourceserver:
        jwt:
          jwk-set-uri: 'http://mall-gateway-service:8201/mall-auth/rsa/publicKey'
logging:
  file:
    path: /var/logs
  level:
    root: info
    com.macro.mall: info
logstash:
  host: 172.22.111.32
```

> ⚠️ `mall-gateway-service` 是 K8S Service 名，不是 IP。部署后 k3s 的 CoreDNS 会自动解析。

#### mall-portal-prod.yaml

**Data ID**: `mall-portal-prod.yaml`
**Group**: `DEFAULT_GROUP`
**配置格式**: YAML

```yaml
spring:
  datasource:
    url: jdbc:mysql://172.22.111.32:3306/mall?useUnicode=true&characterEncoding=utf-8&serverTimezone=Asia/Shanghai&useSSL=false
    username: root
    password: root
  data:
    mongodb:
      host: 172.22.111.32
      port: 27017
      database: mall-port
  redis:
    host: 172.22.111.32
    database: 0
    port: 6379
    password:
  rabbitmq:
    host: 172.22.111.32
    port: 5672
    virtual-host: /mall
    username: guest
    password: guest
    publisher-confirms: true
logging:
  file:
    path: /var/logs
  level:
    root: info
    com.macro.mall: info
logstash:
  host: 172.22.111.32
```

#### mall-search-prod.yaml

**Data ID**: `mall-search-prod.yaml`
**Group**: `DEFAULT_GROUP`
**配置格式**: YAML

```yaml
spring:
  datasource:
    url: jdbc:mysql://172.22.111.32:3306/mall?useUnicode=true&characterEncoding=utf-8&serverTimezone=Asia/Shanghai&useSSL=false
    username: root
    password: root
  elasticsearch:
    uris: 172.22.111.32:9200
management:
  health:
    elasticsearch:
      response-timeout: 1000ms
logging:
  file:
    path: /var/logs
  level:
    root: info
    com.macro.mall: info
logstash:
  host: 172.22.111.32
```

---

### 创建完成后确认

在 Nacos「配置管理 → 配置列表」中应看到 4 个配置：

| Data ID                | Group         |
| ---------------------- | ------------- |
| mall-admin-prod.yaml   | DEFAULT_GROUP |
| mall-gateway-prod.yaml | DEFAULT_GROUP |
| mall-portal-prod.yaml  | DEFAULT_GROUP |
| mall-search-prod.yaml  | DEFAULT_GROUP |

---

### ⚠️ 初始化 MySQL 数据库和 RabbitMQ

Nacos 配置完成后，**必须在部署应用之前**初始化数据库和消息队列。

#### 上传 mall.sql

将项目中的 `document/sql/mall.sql` 上传到 ECS-01：

```bash
# 在 Windows 本地终端执行（切换到 mall.sql 所在目录）
scp mall.sql root@101.37.34.6:/tmp/
```

#### 初始化 MySQL

SSH 到 ECS-01 执行：

```bash
# 创建数据库（如果重复执行先删掉重建）
docker exec -i mysql mysql -uroot -proot -e "DROP DATABASE IF EXISTS mall;"
docker exec -i mysql mysql -uroot -proot -e "CREATE DATABASE mall DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# 导入表结构
docker exec -i mysql mysql -uroot -proot --default-character-set=utf8mb4 mall < /tmp/mall.sql

# 验证（应显示 76 张表）
docker exec -i mysql mysql -uroot -proot -e "USE mall; SHOW TABLES;" | wc -l
```

#### 配置 RabbitMQ

```bash
# 创建 /mall 虚拟主机（portal 服务使用）
docker exec rabbitmq rabbitmqctl add_vhost /mall
docker exec rabbitmq rabbitmqctl set_permissions -p /mall guest ".*" ".*" ".*"
```

> ⚠️ 如果跳过这一步，mall-portal 会因 RabbitMQ 连接失败而不断重启。

---

## Phase 6 — K8S 部署应用服务

### 目标

将 mall-swarm 的 6 个微服务部署到 ECS-02 的 k3s 集群中。

---

### 微服务清单

| 服务         | 容器端口 | Service 类型 | NodePort |
| ------------ | :------: | ------------ | :------: |
| mall-gateway |   8201   | NodePort     |  30201   |
| mall-auth    |   8401   | ClusterIP    |    -     |
| mall-admin   |   8080   | ClusterIP    |    -     |
| mall-portal  |   8085   | ClusterIP    |    -     |
| mall-search  |   8081   | ClusterIP    |    -     |
| mall-monitor |   8101   | ClusterIP    |    -     |

> 只有 Gateway 需要外部访问，使用 NodePort 暴露。其他服务通过集群内部 Service 名通信。

---

### 准备 K8S YAML 文件

在 **ECS-02** 上创建部署文件目录并写入修正后的 YAML：

> 以下命令在 ECS-02 上执行。

```bash
mkdir -p /root/k8s
cd /root/k8s
```

#### mall-admin-deployment.yaml

```bash
cat > mall-admin-deployment.yaml << 'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mall-admin-deployment
  labels:
    app: mall-admin
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mall-admin
  template:
    metadata:
      labels:
        app: mall-admin
    spec:
      containers:
        - name: mall-admin
          image: macrodocker/mall-admin:1.0-SNAPSHOT
          ports:
            - containerPort: 8080
          env:
            - name: spring.profiles.active
              value: prod
            - name: TZ
              value: Asia/Shanghai
            - name: spring.cloud.nacos.discovery.server-addr
              value: http://172.22.111.32:8848
            - name: spring.cloud.nacos.config.server-addr
              value: http://172.22.111.32:8848
          volumeMounts:
            - mountPath: /var/logs
              name: log-volume
      volumes:
        - name: log-volume
          hostPath:
            path: /mydata/app/mall-admin/logs
            type: DirectoryOrCreate
EOF
```

#### mall-admin-service.yaml

```bash
cat > mall-admin-service.yaml << 'EOF'
apiVersion: v1
kind: Service
metadata:
  name: mall-admin-service
spec:
  type: ClusterIP
  selector:
    app: mall-admin
  ports:
    - name: http
      protocol: TCP
      port: 8080
      targetPort: 8080
EOF
```

#### mall-gateway-deployment.yaml

```bash
cat > mall-gateway-deployment.yaml << 'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mall-gateway-deployment
  labels:
    app: mall-gateway
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mall-gateway
  template:
    metadata:
      labels:
        app: mall-gateway
    spec:
      containers:
        - name: mall-gateway
          image: macrodocker/mall-gateway:1.0-SNAPSHOT
          ports:
            - containerPort: 8201
          env:
            - name: spring.profiles.active
              value: prod
            - name: TZ
              value: Asia/Shanghai
            - name: spring.cloud.nacos.discovery.server-addr
              value: http://172.22.111.32:8848
            - name: spring.cloud.nacos.config.server-addr
              value: http://172.22.111.32:8848
          volumeMounts:
            - mountPath: /var/logs
              name: log-volume
      volumes:
        - name: log-volume
          hostPath:
            path: /mydata/app/mall-gateway/logs
            type: DirectoryOrCreate
EOF
```

#### mall-gateway-service.yaml

```bash
cat > mall-gateway-service.yaml << 'EOF'
apiVersion: v1
kind: Service
metadata:
  name: mall-gateway-service
spec:
  type: NodePort
  selector:
    app: mall-gateway
  ports:
    - name: http
      protocol: TCP
      port: 8201
      targetPort: 8201
      nodePort: 30201
EOF
```

#### mall-auth-deployment.yaml

```bash
cat > mall-auth-deployment.yaml << 'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mall-auth-deployment
  labels:
    app: mall-auth
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mall-auth
  template:
    metadata:
      labels:
        app: mall-auth
    spec:
      containers:
        - name: mall-auth
          image: macrodocker/mall-auth:1.0-SNAPSHOT
          ports:
            - containerPort: 8401
          env:
            - name: spring.profiles.active
              value: prod
            - name: TZ
              value: Asia/Shanghai
            - name: spring.cloud.nacos.discovery.server-addr
              value: http://172.22.111.32:8848
            - name: spring.cloud.nacos.config.server-addr
              value: http://172.22.111.32:8848
          volumeMounts:
            - mountPath: /var/logs
              name: log-volume
      volumes:
        - name: log-volume
          hostPath:
            path: /mydata/app/mall-auth/logs
            type: DirectoryOrCreate
EOF
```

#### mall-auth-service.yaml

```bash
cat > mall-auth-service.yaml << 'EOF'
apiVersion: v1
kind: Service
metadata:
  name: mall-auth-service
spec:
  type: ClusterIP
  selector:
    app: mall-auth
  ports:
    - name: http
      protocol: TCP
      port: 8401
      targetPort: 8401
EOF
```

#### mall-portal-deployment.yaml

```bash
cat > mall-portal-deployment.yaml << 'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mall-portal-deployment
  labels:
    app: mall-portal
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mall-portal
  template:
    metadata:
      labels:
        app: mall-portal
    spec:
      containers:
        - name: mall-portal
          image: macrodocker/mall-portal:1.0-SNAPSHOT
          ports:
            - containerPort: 8085
          env:
            - name: spring.profiles.active
              value: prod
            - name: TZ
              value: Asia/Shanghai
            - name: spring.cloud.nacos.discovery.server-addr
              value: http://172.22.111.32:8848
            - name: spring.cloud.nacos.config.server-addr
              value: http://172.22.111.32:8848
          volumeMounts:
            - mountPath: /var/logs
              name: log-volume
      volumes:
        - name: log-volume
          hostPath:
            path: /mydata/app/mall-portal/logs
            type: DirectoryOrCreate
EOF
```

#### mall-portal-service.yaml

```bash
cat > mall-portal-service.yaml << 'EOF'
apiVersion: v1
kind: Service
metadata:
  name: mall-portal-service
spec:
  type: ClusterIP
  selector:
    app: mall-portal
  ports:
    - name: http
      protocol: TCP
      port: 8085
      targetPort: 8085
EOF
```

#### mall-search-deployment.yaml

```bash
cat > mall-search-deployment.yaml << 'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mall-search-deployment
  labels:
    app: mall-search
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mall-search
  template:
    metadata:
      labels:
        app: mall-search
    spec:
      containers:
        - name: mall-search
          image: macrodocker/mall-search:1.0-SNAPSHOT
          ports:
            - containerPort: 8081
          env:
            - name: spring.profiles.active
              value: prod
            - name: TZ
              value: Asia/Shanghai
            - name: spring.cloud.nacos.discovery.server-addr
              value: http://172.22.111.32:8848
            - name: spring.cloud.nacos.config.server-addr
              value: http://172.22.111.32:8848
          volumeMounts:
            - mountPath: /var/logs
              name: log-volume
      volumes:
        - name: log-volume
          hostPath:
            path: /mydata/app/mall-search/logs
            type: DirectoryOrCreate
EOF
```

#### mall-search-service.yaml

```bash
cat > mall-search-service.yaml << 'EOF'
apiVersion: v1
kind: Service
metadata:
  name: mall-search-service
spec:
  type: ClusterIP
  selector:
    app: mall-search
  ports:
    - name: http
      protocol: TCP
      port: 8081
      targetPort: 8081
EOF
```

#### mall-monitor-deployment.yaml

```bash
cat > mall-monitor-deployment.yaml << 'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mall-monitor-deployment
  labels:
    app: mall-monitor
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mall-monitor
  template:
    metadata:
      labels:
        app: mall-monitor
    spec:
      containers:
        - name: mall-monitor
          image: macrodocker/mall-monitor:1.0-SNAPSHOT
          ports:
            - containerPort: 8101
          env:
            - name: spring.profiles.active
              value: prod
            - name: TZ
              value: Asia/Shanghai
            - name: spring.cloud.nacos.discovery.server-addr
              value: http://172.22.111.32:8848
            - name: spring.cloud.nacos.config.server-addr
              value: http://172.22.111.32:8848
          volumeMounts:
            - mountPath: /var/logs
              name: log-volume
      volumes:
        - name: log-volume
          hostPath:
            path: /mydata/app/mall-monitor/logs
            type: DirectoryOrCreate
EOF
```

#### mall-monitor-service.yaml

```bash
cat > mall-monitor-service.yaml << 'EOF'
apiVersion: v1
kind: Service
metadata:
  name: mall-monitor-service
spec:
  type: ClusterIP
  selector:
    app: mall-monitor
  ports:
    - name: http
      protocol: TCP
      port: 8101
      targetPort: 8101
EOF
```

---

### 部署所有服务

```bash
cd /root/k8s

# 批量应用所有 YAML
kubectl apply -f .

# 查看 Pod 启动状态
kubectl get pods -w
```

> 等待所有 Pod 变成 `Running`。首次可能需要几分钟，因为 k3s 需要从 containerd 加载镜像。

---

### 验证部署

```bash
# 查看所有 Deployment
kubectl get deployments

# 查看所有 Service
kubectl get svc

# 查看所有 Pod
kubectl get pods

# 查看某个 Pod 的日志（如果启动失败）
kubectl logs deployment/mall-gateway-deployment
```

预期结果：

```
NAME                     READY   STATUS    RESTARTS   AGE
mall-admin-xxx           1/1     Running   0          xx
mall-auth-xxx            1/1     Running   0          xx
mall-gateway-xxx         1/1     Running   0          xx
mall-monitor-xxx         1/1     Running   0          xx
mall-portal-xxx          1/1     Running   0          xx
mall-search-xxx          1/1     Running   0          xx
```

---

## Phase 7 — 外部访问与整体验证

### 访问入口

| 服务                                | 地址                               |
| ----------------------------------- | ---------------------------------- |
| **API 网关（接口文档）**            | http://47.99.180.47:30201/doc.html |
| **Nacos 控制台**                    | http://101.37.34.6:8848/nacos      |
| **RabbitMQ 管理**（账户/密码guest） | http://101.37.34.6:15672           |
| **Kibana**                          | http://101.37.34.6:56              |

---

## Phase 8：前端部署

### ⚠️ 关键约束

- **必须使用 v1.0.0 旧版前端**（webpack 构建，新版 Vite 与后端不兼容）
- **必须使用 Node.js 14**（Node.js 16+ 无法编译）

### 步骤

```bash
# 1. Windows 安装 nvm-windows，切换到 Node 14
nvm install 14.21.3
nvm use 14.21.3

# 2. 克隆旧版前端
git clone https://gitee.com/macrozheng/mall-admin-web.git
cd mall-admin-web
git checkout v1.0.0

# 3. 修改 config/prod.env.js
# BASE_API: '"http://47.99.180.47:30201"'

# 4. 修改 src/utils/request.js，添加请求拦截器
# config.url = '/mall-admin' + config.url

# 5. 构建部署
npm install --registry=https://registry.npmmirror.com
npm run build
scp -r dist/* root@101.37.34.6:/tmp/
```

### ECS-01 Nginx 配置

```bash
mkdir -p /mydata/nginx/html/admin/
cp -r /tmp/dist/* /mydata/nginx/html/admin/

cat > /mydata/nginx/conf/conf.d/admin.conf << 'EOF'
server {
    listen 80;
    location /admin/ {
        alias /usr/share/nginx/html/admin/;
        index index.html;
        try_files $uri $uri/ /admin/index.html;
    }
    location /admin { return 301 /admin/; }
}
EOF

docker restart nginx
```

### 确认 nginx.conf 加载 conf.d

```bash
grep "include.*conf.d" /mydata/nginx/conf/nginx.conf || \
  sed -i '/sendfile/a\    include /etc/nginx/conf.d/*.conf;' /mydata/nginx/conf/nginx.conf
```

---

## 账号密码汇总

| 系统     | 地址                          | 账号/密码                  |
| -------- | ----------------------------- | -------------------------- |
| 管理后台 | http://101.37.34.6/admin/     | admin / macro123或者123456 |
| Nacos    | http://101.37.34.6:8848/nacos | nacos / nacos              |
| RabbitMQ | http://101.37.34.6:15672      | guest / guest              |
| MySQL    | 172.22.111.32:3306            | root / root                |