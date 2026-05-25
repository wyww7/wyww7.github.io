---
title: k8s安装
date: 2026-05-25
lastmod: 2026-05-25
description: 使用虚拟机安装部署k8s
image: ScreenShot_2026-05-25_183339_181.png
categories:		# 文章外标签
    - Documentation
    - 部署
tags:			# 文章内标签
    - 隐私
    - test
---

## K8S安装具体步骤

>***操作系统：centos 7.9***
>
>配置：内存4vCPU、40G硬盘

| **节点IP**         | **主机名**   | **核心组件/职责**                                            |
| ------------------ | ------------ | ------------------------------------------------------------ |
| **192.168.20.126** | `k8s-master` | `kube-apiserver`, `kube-scheduler`, `kube-controller-manager`, `etcd` |
| **192.168.20.127** | `k8s-node01` | `kubelet`, `kube-proxy`, 容器运行时 (Docker/Containerd)，运行业务Pod |
| **192.168.20.128** | `k8s-node02` | `kubelet`, `kube-proxy`, 容器运行时 (Docker/Containerd)，运行业务Pod |

### 配置主机名和hosts文件

```bash
# 设置主机名
hostnamectl set-hostname k8s-master

# 配置hosts文件
cat >> /etc/hosts <<EOF
192.168.20.126 k8s-master
192.168.20.127 k8s-node01
192.168.20.128 k8s-node02
EOF

# 新增
echo "192.168.20.xx k8s-node03" >> /etc/hosts
```

### 关闭交换分区

> [!CAUTION]
>
> 注意：我们的服务器如果没有swaf分区，则这一步直接跳过。

```bash
# 临时关闭
swapoff -a

# 永久关闭，注释swap挂载
sed -i 's/.*swap.*/#&/' /etc/fstab
```

### 配置内核参数

```bash
# 加载网络过滤模块
modprobe br_netfilter
echo "modprobe br_netfilter" >> /etc/profile

# 配置内核参数
cat > /etc/sysctl.d/k8s.conf <<EOF
net.bridge.bridge-nf-call-ip6tables = 1
net.bridge.bridge-nf-call-iptables = 1
net.ipv4.ip_forward = 1
EOF

# 生效配置
sysctl -p /etc/sysctl.d/k8s.conf
```

### 关闭SELinux

> [!CAUTION]
>
> 注意：我们的服务器如果没有swaf分区，则这一步直接跳过。

```bash
# 临时关闭
setenforce 0

# 永久关闭
sed -i 's/SELINUX=enforcing/SELINUX=disabled/' /etc/selinux/config
```

### 配置镜像源

```bash
rm -rf /etc/yum.repos.d/*
curl -o /etc/yum.repos.d/CentOS-Base.repo https://mirrors.huaweicloud.com/repository/conf/CentOS-7-anon.repo
cat > /etc/yum.repos.d/epel.repo <<EOF
[epel]
name=Extra Packages for Enterprise Linux 7 - \$basearch
baseurl=https://mirrors.huaweicloud.com/epel/7/\$basearch
failovermethod=priority
enabled=1
gpgcheck=0
gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-EPEL-7

[epel-debuginfo]
name=Extra Packages for Enterprise Linux 7 - \$basearch - Debug
baseurl=https://mirrors.huaweicloud.com/epel/7/\$basearch/debug
failovermethod=priority
enabled=0
gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-EPEL-7
gpgcheck=0

[epel-source]
name=Extra Packages for Enterprise Linux 7 - \$basearch - Source
baseurl=https://mirrors.huaweicloud.com/epel/7/SRPMS
failovermethod=priority
enabled=0
gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-EPEL-7
gpgcheck=0
EOF

# Docker 源
wget -O /etc/yum.repos.d/docker-ce.repo https://mirrors.huaweicloud.com/docker-ce/linux/centos/docker-ce.repo
sudo sed -i 's+download.docker.com+mirrors.huaweicloud.com/docker-ce+' /etc/yum.repos.d/docker-ce.repo

# k8s 源
cat <<EOF | tee /etc/yum.repos.d/kubernetes.repo
[kubernetes]
name=Kubernetes
baseurl=https://mirrors.aliyun.com/kubernetes-new/core/stable/v1.32/rpm/
enabled=1
gpgcheck=1
gpgkey=https://mirrors.aliyun.com/kubernetes-new/core/stable/v1.32/rpm/repodata/repomd.xml.key
EOF
```

### 启用IPVS

```bash
cat > /etc/sysconfig/modules/ipvs.modules <<EOF
#!/bin/bash
ipvs_modules="ip_vs ip_vs_lc ip_vs_wlc ip_vs_rr ip_vs_wrr ip_vs_lblc ip_vs_lblcr ip_vs_dh ip_vs_sh ip_vs_nq ip_vs_sed ip_vs_ftp nf_conntrack"
for kernel_module in \${ipvs_modules}; do
 /sbin/modinfo -F filename \${kernel_module} > /dev/null 2>&1
 if [ 0 -eq 0 ]; then
 /sbin/modprobe \${kernel_module}
 fi
done
EOF

# 加载IPVS模块
chmod 755 /etc/sysconfig/modules/ipvs.modules && bash /etc/sysconfig/modules/ipvs.modules

# 验证模块加载
lsmod | grep ip_vs
```

### 安装基础软件包

```bash
yum install -y yum-utils device-mapper-persistent-data lvm2 wget net-tools nfs-utils gcc gcc-c++ make cmake libxml2-devel openssl-devel curl curl-devel unzip sudo ntp libaio-devel wget vim ncurses-devel autoconf automake zlib-devel python-devel epel-release openssh-server socat ipvsadm conntrack ntpdate telnet ipvsadm
```

## K8S集群初始化步骤

### 安装containerd.io与kubernetes

```bash
yum install kubelet-1.32.11 kubeadm-1.32.11 kubectl-1.32.11 containerd container-selinux

systemctl enable --now containerd
systemctl enable --now kubelet
```

### 配置Containerd所需的模块

```bash
cat <<EOF | sudo tee /etc/modules-load.d/containerd.conf
overlay
br_netfilter
EOF

# 加载 br_netfilter 系统模块
modprobe br_netfilter

# 参数解释：
#
# containerd是一个容器运行时，用于管理和运行容器。它支持多种不同的参数配置来自定义容器运行时的行为和功能。
# 
# 1. overlay：overlay是容器的默认使用的存储驱动，它提供了一种轻量级的、可堆叠的、逐层增量的文件系统。它通过在现有文件系统上叠加文件系统层来创建容器的文件系统视图。每个容器可以有自己的一组文件系统层，这些层可以共享基础镜像中的文件，并在容器内部进行修改。使用overlay可以有效地使用磁盘空间，并使容器更加轻量级。
# 
# 2. br_netfilter：br_netfilter是Linux内核提供的一个网络过滤器模块，用于在容器网络中进行网络过滤和NAT转发。当容器和主机之间的网络通信需要进行DNAT或者SNAT时，br_netfilter模块可以将IP地址进行转换。它还可以提供基于iptables规则的网络过滤功能，用于限制容器之间或容器与外部网络之间的通信。
# 
# 这些参数可以在containerd的配置文件或者命令行中指定。例如，可以通过设置--storage-driver参数来选择使用overlay作为存储驱动，通过设置--iptables参数来启用或禁用br_netfilter模块。具体的使用方法和配置细节可以参考containerd的官方文档。
```

### 修改Containerd默认配置

```bash
containerd config default | tee /etc/containerd/config.toml

sed -i "s#registry.k8s.io/pause:3.6#registry.aliyuncs.com/google_containers/pause:3.10#g" /etc/containerd/config.toml
sed -i "s#SystemdCgroup = false#SystemdCgroup = true#g" /etc/containerd/config.toml

# SystemdCgroup参数是containerd中的一个配置参数，用于设置containerd在运行过程中使用的Cgroup（控制组）路径。Containerd使用SystemdCgroup参数来指定应该使用哪个Cgroup来跟踪和管理容器的资源使用。
# 
# Cgroup是Linux内核提供的一种资源隔离和管理机制，可以用于限制、分配和监控进程组的资源使用。使用Cgroup，可以将容器的资源限制和隔离，以防止容器之间的资源争用和不公平的竞争。
# 
# 通过设置SystemdCgroup参数，可以确保containerd能够找到正确的Cgroup路径，并正确地限制和隔离容器的资源使用，确保容器可以按照预期的方式运行。如果未正确设置SystemdCgroup参数，可能会导致容器无法正确地使用资源，或者无法保证资源的公平分配和隔离。
# 
# 总而言之，SystemdCgroup参数的作用是为了确保containerd能够正确地管理容器的资源使用，以实现资源的限制、隔离和公平分配。
```

### 配置crictl客户端连接的运行时

```bash
wget https://github.chenc.dev/github.com/kubernetes-sigs/cri-tools/releases/download/v1.34.0/crictl-v1.34.0-linux-amd64.tar.gz

#解压
tar xf crictl-v1.34.0-linux-amd64.tar.gz -C /usr/bin/

#生成配置文件
cat > /etc/crictl.yaml <<EOF
runtime-endpoint: unix:///run/containerd/containerd.sock
image-endpoint: unix:///run/containerd/containerd.sock
timeout: 10
debug: false
EOF

#测试
systemctl restart containerd

crictl info

# 注意！
# 下面是参数`crictl`的详细解释
# 
# `crictl`是一个用于与容器运行时通信的命令行工具。它是容器运行时接口（CRI）工具的一个实现，可以对容器运行时进行管理和操作。
# 
# 1. `runtime-endpoint: unix:///run/containerd/containerd.sock`
# 指定容器运行时的终端套接字地址。在这个例子中，指定的地址是`unix:///run/containerd/containerd.sock`，这是一个Unix域套接字地址。
# 
# 2. `image-endpoint: unix:///run/containerd/containerd.sock`
# 指定容器镜像服务的终端套接字地址。在这个例子中，指定的地址是`unix:///run/containerd/containerd.sock`，这是一个Unix域套接字地址。
# 
# 3. `timeout: 10`
# 设置与容器运行时通信的超时时间，单位是秒。在这个例子中，超时时间被设置为10秒。
# 
# 4. `debug: false`
# 指定是否开启调式模式。在这个例子中，调式模式被设置为关闭，即`false`。如果设置为`true`，则会输出更详细的调试信息。
# 
# 这些参数可以根据需要进行修改，以便与容器运行时进行有效的通信和管理。
```

### 初始化k8s

> [!NOTE]
>
> 生成K8S Master节点初始化默认配置文件的命令：kubeadm config print init-defaults > kubeadm-init-config.yaml

```bash
# 重点
# 重点
# 重点
# 只在 master 节点上执行
kubeadm init --kubernetes-version=1.32.11 \
--apiserver-advertise-address=192.168.20.126 \
--image-repository registry.aliyuncs.com/google_containers \
--pod-network-cidr=10.244.0.0/16 \
--service-cidr=10.96.0.0/12
```

### 开始初始化k8s-master

初始化过程示例

```bash
[root@k8s-master ~]# kubeadm init --kubernetes-version=1.32.11 \
> --apiserver-advertise-address=192.168.20.126 \
> --image-repository registry.aliyuncs.com/google_containers \
> --pod-network-cidr=10.244.0.0/16 \
> --service-cidr=10.96.0.0/12
[init] Using Kubernetes version: v1.32.11
[preflight] Running pre-flight checks
        [WARNING SystemVerification]: cgroups v1 support is in maintenance mode, please migrate to cgroups v2
        [WARNING Hostname]: hostname "k8s-master" could not be reached
        [WARNING Hostname]: hostname "k8s-master": lookup k8s-master on 114.114.114.114:53: no such host
[preflight] Pulling images required for setting up a Kubernetes cluster
[preflight] This might take a minute or two, depending on the speed of your internet connection
[preflight] You can also perform this action beforehand using 'kubeadm config images pull'
[certs] Using certificateDir folder "/etc/kubernetes/pki"
[certs] Generating "ca" certificate and key
[certs] Generating "apiserver" certificate and key
[certs] apiserver serving cert is signed for DNS names [k8s-master kubernetes kubernetes.default kubernetes.default.svc kubernetes.default.svc.cluster.local] and IPs [10.96.0.1 192.168.20.126]
[certs] Generating "apiserver-kubelet-client" certificate and key
[certs] Generating "front-proxy-ca" certificate and key
[certs] Generating "front-proxy-client" certificate and key
[certs] Generating "etcd/ca" certificate and key
[certs] Generating "etcd/server" certificate and key
[certs] etcd/server serving cert is signed for DNS names [k8s-master localhost] and IPs [192.168.20.126 127.0.0.1 ::1]
[certs] Generating "etcd/peer" certificate and key
[certs] etcd/peer serving cert is signed for DNS names [k8s-master localhost] and IPs [192.168.20.126 127.0.0.1 ::1]
[certs] Generating "etcd/healthcheck-client" certificate and key
[certs] Generating "apiserver-etcd-client" certificate and key
[certs] Generating "sa" key and public key
[kubeconfig] Using kubeconfig folder "/etc/kubernetes"
[kubeconfig] Writing "admin.conf" kubeconfig file
[kubeconfig] Writing "super-admin.conf" kubeconfig file
[kubeconfig] Writing "kubelet.conf" kubeconfig file
[kubeconfig] Writing "controller-manager.conf" kubeconfig file
[kubeconfig] Writing "scheduler.conf" kubeconfig file
[etcd] Creating static Pod manifest for local etcd in "/etc/kubernetes/manifests"
[control-plane] Using manifest folder "/etc/kubernetes/manifests"
[control-plane] Creating static Pod manifest for "kube-apiserver"
[control-plane] Creating static Pod manifest for "kube-controller-manager"
[control-plane] Creating static Pod manifest for "kube-scheduler"
[kubelet-start] Writing kubelet environment file with flags to file "/var/lib/kubelet/kubeadm-flags.env"
[kubelet-start] Writing kubelet configuration to file "/var/lib/kubelet/config.yaml"
[kubelet-start] Starting the kubelet
[wait-control-plane] Waiting for the kubelet to boot up the control plane as static Pods from directory "/etc/kubernetes/manifests"
[kubelet-check] Waiting for a healthy kubelet at http://127.0.0.1:10248/healthz. This can take up to 4m0s
[kubelet-check] The kubelet is healthy after 1.556036316s
[api-check] Waiting for a healthy API server. This can take up to 4m0s
[api-check] The API server is healthy after 24.503010649s
[upload-config] Storing the configuration used in ConfigMap "kubeadm-config" in the "kube-system" Namespace
[kubelet] Creating a ConfigMap "kubelet-config" in namespace kube-system with the configuration for the kubelets in the cluster
[upload-certs] Skipping phase. Please see --upload-certs
[mark-control-plane] Marking the node k8s-master as control-plane by adding the labels: [node-role.kubernetes.io/control-plane node.kubernetes.io/exclude-from-external-load-balancers]
[mark-control-plane] Marking the node k8s-master as control-plane by adding the taints [node-role.kubernetes.io/control-plane:NoSchedule]
[bootstrap-token] Using token: ay0ssx.stiv0bzymxiyhac1
[bootstrap-token] Configuring bootstrap tokens, cluster-info ConfigMap, RBAC Roles
[bootstrap-token] Configured RBAC rules to allow Node Bootstrap tokens to get nodes
[bootstrap-token] Configured RBAC rules to allow Node Bootstrap tokens to post CSRs in order for nodes to get long term certificate credentials
[bootstrap-token] Configured RBAC rules to allow the csrapprover controller automatically approve CSRs from a Node Bootstrap Token
[bootstrap-token] Configured RBAC rules to allow certificate rotation for all node client certificates in the cluster
[bootstrap-token] Creating the "cluster-info" ConfigMap in the "kube-public" namespace
[kubelet-finalize] Updating "/etc/kubernetes/kubelet.conf" to point to a rotatable kubelet client certificate and key
[addons] Applied essential addon: CoreDNS
[addons] Applied essential addon: kube-proxy

Your Kubernetes control-plane has initialized successfully!

To start using your cluster, you need to run the following as a regular user:

  mkdir -p $HOME/.kube
  sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
  sudo chown $(id -u):$(id -g) $HOME/.kube/config

Alternatively, if you are the root user, you can run:

  export KUBECONFIG=/etc/kubernetes/admin.conf

You should now deploy a pod network to the cluster.
Run "kubectl apply -f [podnetwork].yaml" with one of the options listed at:
  https://kubernetes.io/docs/concepts/cluster-administration/addons/

Then you can join any number of worker nodes by running the following on each as root:

kubeadm join 192.168.20.126:6443 --token ay0ssx.stiv0bzymxiyhac1 \
        --discovery-token-ca-cert-hash sha256:a9c96e0b0fa3f28931d10794de63e730c642f707b71c942ddbd01f0ce50f9b25
[root@k8s-master ~]# 
```

```bash
# 在主节点运行
mkdir -p $HOME/.kube
sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config
```

```bash
# 重新初始化

# 只有一个CRI的情况下
kubeadm reset
# 指定CRI重置
kubeadm reset --cri-socket unix:///var/run/cri-dockerd.sock
kubeadm reset --cri-socket unix:///var/run/containerd/containerd.sock
```

## 将node节点加入集群

>如果出现，Token过期，或者找不到token的情况下，可以通过在 Master 节点上执行：kubeadm token create --print-join-command ，得到最新的Token

在工作节点运行

```bash
kubeadm join 192.168.20.126:6443 --token ay0ssx.stiv0bzymxiyhac1 \
        --discovery-token-ca-cert-hash sha256:a9c96e0b0fa3f28931d10794de63e730c642f707b71c942ddbd01f0ce50f9b25
```

## 网络插件安装步骤

**给容器运行时配置“镜像加速器”**

修改所有节点上的 `containerd` 配置文件，在 **Master** 和 **所有 Node 节点**上，执行以下步骤：

使用 `vim` 打开 containerd 的主配置文件：

```bash
vim /etc/containerd/config.toml
```

检查并开启镜像配置目录（CRI 插件配置）

在文件中使用 `/` 搜索 `[plugins."io.containerd.grpc.v1.cri".registry]`，确保或者修改为以下内容：

```ini
[plugins."io.containerd.grpc.v1.cri".registry]
        # 告诉 containerd 去这个目录下寻找每个镜像仓库的加速配置
        config_path = "/etc/containerd/certs.d"
```

> [!CAUTION]
>
> **注意**：较新版本的 `containerd` 推荐使用 `certs.d` 目录来分主机管理镜像源，而不是直接死写在 `config.toml` 里，这样更清晰也更容易维护。

```bash
# 保存并重启 containerd
systemctl restart containerd
```

**创建真正的镜像加速规则（重点）**

在**每个节点**上执行以下命令，创建对应的加速规则目录和文件：

```bash
# 1. 创建 docker.io 的配置专属目录
mkdir -p /etc/containerd/certs.d/docker.io

# 创建 registry.k8s.io 的配置目录
mkdir -p /etc/containerd/certs.d/registry.k8s.io

# 2. 写入加速器配置
cat > /etc/containerd/certs.d/docker.io/hosts.toml <<EOF
server = "https://registry-1.docker.io"

[host."https://docker.m.daocloud.io"]
  capabilities = ["pull", "resolve"]

[host."https://docker.1ms.run"]
  capabilities = ["pull", "resolve"]

[host."https://dockerpull.com"]
  capabilities = ["pull", "resolve"]
EOF

# 写入阿里云或国内开发者维护的同步源
cat > /etc/containerd/certs.d/registry.k8s.io/hosts.toml <<EOF
server = "https://registry.k8s.io"

[host."https://k8s.m.daocloud.io"]
  capabilities = ["pull", "resolve"]

[host."https://k8s-gcr.1ms.run"]
  capabilities = ["pull", "resolve"]

[host."https://registry.aliyuncs.com/google_containers"]
  capabilities = ["pull", "resolve"]
EOF
```

```bash
# 下载并应用Calico配置
kubectl apply -f calico.yaml

# 查看安装状态
kubectl get pods -n kube-system
```

### 验证网络功能

```bash
# 创建测试Pod
kubectl run busybox --image docker.io/library/busybox:latest --restart=Never --rm -it -- sh

# 在Pod内测试网络连通性
nslookup kubernetes.default.svc.cluster.local
```

出现如下则配置成功

```bash
If you don't see a command prompt, try pressing enter.
/ # nslookup kubernetes.default.svc.cluster.local
Server:         10.96.0.10
Address:        10.96.0.10:53

Name:   kubernetes.default.svc.cluster.local
Address: 10.96.0.1