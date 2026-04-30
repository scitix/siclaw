# Siclaw K8s 一键部署 — 同事上手指南

> 假设你刚拉到这个分支、对 Siclaw 内部架构一无所知。跟着这份文档走，约 15 分钟内你能让 Siclaw 跑在测试集群里，并用 Mac 浏览器点开前端。

---

## 0. 前置检查清单（30 秒）

在开发机上跑一遍，全部 OK 再继续：

```bash
helm version       # v3.x
kubectl version --client
kubectl config current-context   # 确认指向你要部署的集群
openssl version
```

任何一个命令报 `command not found`，先装上再回来。helm 没权限装的话，下载二进制到 `~/bin`：

```bash
mkdir -p ~/bin
curl -fsSL https://get.helm.sh/helm-v3.16.2-linux-amd64.tar.gz | tar -xz -C /tmp
mv /tmp/linux-amd64/helm ~/bin/helm && chmod +x ~/bin/helm
echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
```
---

## 1. 构建三个镜像

Siclaw 由三个组件组成，**必须共用同一个 git commit、同一个 tag**：

| 镜像 | 跑什么 |
|---|---|
| `siclaw-portal` | Web 前端 + 用户/会话/聊天 API |
| `siclaw-runtime` | 调度器，按需拉起 agentbox |
| `siclaw-agentbox` | 真正干活的 agent 进程（每个用户对话一个 pod，按需拉起） |

**做法**：

1. 打开公司 DevOps 平台
2. 选 `siclaw-portal-1` / `siclaw-runtime-1` / `siclaw-agentbox-1` 三个构建任务
3. 在"源码配置"里选 **Region**（北京 / 上海 / 马来 / 美东 任选——后面 chart 不写死，选你最近的就行）和 **代码分支**
4. 镜像 Tag 留空让系统自动生成（一般是 `<branch>-<commit短hash>`），或手填一个。**三个构建用同一个 tag**
5. 点"执行"，等三个构建完成
6. 把三个镜像的完整 ref 复制下来，例如：

```
registry-cn-shanghai.siflow.cn/k8s/siclaw-portal:yye-feat-trace-store-v2-6330af8
registry-cn-shanghai.siflow.cn/k8s/siclaw-runtime:yye-feat-trace-store-v2-6330af8
registry-cn-shanghai.siflow.cn/k8s/siclaw-agentbox:yye-feat-trace-store-v2-6330af8
```

⚠️ 三行的 registry 必须相同，tag 必须相同。脚本会校验，不一致直接退出。

---

## 2. 填镜像清单

```bash
cd <repo-root>
# 用示例文件起一个清单
cp scripts/images.txt.example scripts/images.txt
# 编辑成上一步拿到的三行
vim scripts/images.txt
```

`scripts/images.txt` 的格式：

```text
# 注释行被忽略，空行也被忽略
registry-cn-shanghai.siflow.cn/k8s/siclaw-portal:<TAG>
registry-cn-shanghai.siflow.cn/k8s/siclaw-runtime:<TAG>
registry-cn-shanghai.siflow.cn/k8s/siclaw-agentbox:<TAG>
```

> 这个文件不含密码，可以提交到仓库。建议每个常用 region 单独一份（`images-shanghai.txt` / `images-beijing.txt`）。

---

## 3. 一键部署

```bash
./scripts/deploy-k8s.sh
```

脚本会自动完成：

1. 校验 helm / kubectl / openssl 是否可用
2. 解析 `scripts/images.txt`，校验三个组件、registry、tag 一致
3. 首次跑会生成随机 secret 存到 `~/.siclaw-deploy-secrets.env`（mode 600，只你能读）；之后跑会复用
4. `helm upgrade --install` 部署 portal / runtime / demo MySQL
5. 设置 `imagePullPolicy=Always` + 主动 `rollout restart`，**确保即使 tag 没变也会重拉新镜像**
6. 删除现存的 agentbox pod（按需 spawn 的，删了下次发消息会用新镜像创建）
7. 绕过 `migrate.ts` 的外键创建顺序 bug（demo MySQL 上 `SET GLOBAL FOREIGN_KEY_CHECKS=0`）
8. 等 portal/runtime rollout 完成 + endpoints 稳定（**避免 port-forward 抓到 Terminating 的旧 pod**——这是脚本自动处理的）
9. 在开发机后台启动 `kubectl port-forward`，监听 `0.0.0.0:3003`
10. 打印你 Mac 上能直接点开的 URL

跑完最后一行会看到类似：

```
✅ Portal is live. From your Mac:

  1) If your Mac is on the same internal network as 10.208.6.202, just open:
       http://10.208.6.202:3003

  2) Otherwise, start an SSH tunnel from your Mac:
       ssh -L 3003:localhost:3003 yye@10.208.6.202
     then open:
       http://localhost:3003
```

---

## 4. Mac 浏览器打开

按上面提示二选一即可。如果不确定 Mac 路由通不通，**先试方案 1，不行再试方案 2**：

```bash
# 在 Mac 终端测一下能不能 ping 通开发机
ping <DEV-MACHINE-IP>
```

ping 通 → 浏览器直接 `http://<DEV-MACHINE-IP>:3003`
ping 不通 → 走 SSH 隧道（方案 2）

### 首次登录前必须先注册 admin

第一个用户没账号——**在开发机上跑一次** curl 注册，注册完它会自动成为 admin：

```bash
curl -X POST http://localhost:3003/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}'
```

返回 `{"token":"...","user":{...}}` 就成功了。回浏览器用 `admin` / `admin` 登录。

---

## 5. 验证 trace 落库

进 Portal UI 找到默认 agent，发一句话（比如"当前集群有多少 pod"），等回复完。然后查 trace MySQL：

```bash
kubectl run -n siclaw mysql-query --rm -it --restart=Never --image=mysql:8.0 -- \
  mysql -hsiclaw-trace-db.default.svc.cluster.local -uroot -psiclawsiclawsiclaw siclaw_traces \
  -e 'SELECT id, session_id, LEFT(user_message, 60), created_at FROM agent_traces ORDER BY id DESC LIMIT 5;'
```

能看到刚才发的消息那一行 → 全链路通了。

---

## 6. 常见问题

### Q1: 浏览器一直转圈

**90% 是 port-forward 的事**。两种情况：

- **port-forward 进程挂了**（重新部署后 portal pod 替换，旧 port-forward 死了）：
  ```bash
  kill $(cat /tmp/siclaw-portforward.pid) 2>/dev/null
  nohup kubectl port-forward -n siclaw --address 0.0.0.0 svc/siclaw-portal 3003:3003 \
    > /tmp/siclaw-portforward.log 2>&1 &
  echo $! > /tmp/siclaw-portforward.pid
  sleep 2 && curl -I http://localhost:3003
  ```
  `curl` 返回 HTTP 头就 OK。

- **port-forward 抓到了 Terminating 的旧 pod**：脚本里已经做了 endpoints 等待逻辑，但万一还是踩到，重启一次 port-forward 就行（同上）。

### Q2: portal pod 一直 CrashLoopBackOff

看日志：

```bash
kubectl logs -n siclaw deploy/siclaw-portal --tail=80
```

如果看到 `ER_FK_CANNOT_OPEN_PARENT` / `Failed to open the referenced table 'skills'`：脚本里的 FK 关闭那一步没执行成功。手动跑一次：

```bash
source ~/.siclaw-deploy-secrets.env
kubectl exec -n siclaw deploy/siclaw-mysql -- \
  mysql -uroot -p"$DB_PASS" -e "SET GLOBAL FOREIGN_KEY_CHECKS=0;"
kubectl rollout restart -n siclaw deploy/siclaw-portal
```

### Q3: 镜像拉不下来 `ImagePullBackOff`

```bash
kubectl describe pod -n siclaw <pod-name> | tail -20
```

看 Events 段。两种原因：

- registry 需要鉴权 → 找运维拿 `imagePullSecret`，namespace 默认 ServiceAccount 上 patch 一下：
  ```bash
  kubectl create secret docker-registry siflow-pull \
    --docker-server=<your-registry-host> \
    --docker-username=... --docker-password=... -n siclaw
  kubectl patch sa default -n siclaw \
    -p '{"imagePullSecrets":[{"name":"siflow-pull"}]}'
  kubectl rollout restart -n siclaw deploy/siclaw-portal deploy/siclaw-runtime
  ```
- 镜像不存在 → 回 DevOps 平台确认构建成功、tag 拼写正确

### Q4: 我想换一个新镜像 / 新分支重新部署

```bash
# 重新构建后改 scripts/images.txt 里的 tag，然后再跑一次：
./scripts/deploy-k8s.sh
```

脚本是幂等的，跑多少次都不会出问题。已注册的 admin 账号会保留（secret 文件复用）。

### Q5: 想清空一切重来

```bash
helm uninstall siclaw -n siclaw
kubectl delete pvc --all -n siclaw    # ⚠️ 清掉 portal demo MySQL 的数据
kubectl delete pod -n siclaw -l 'siclaw.dev/app=agentbox' --ignore-not-found
rm -f ~/.siclaw-deploy-secrets.env    # 强制下次重新生成 secret

./scripts/deploy-k8s.sh
```

---

## 7. 脚本支持的环境变量（高级）

```bash
NAMESPACE=siclaw-test ./scripts/deploy-k8s.sh           # 部到自定义 namespace
TRACE_DB_NS=trace-system ./scripts/deploy-k8s.sh        # trace-db 不在 default namespace
FORCE_RESEED=1 ./scripts/deploy-k8s.sh                  # 强制重新生成 secret（已有用户登录失效）
SKIP_PORTFORWARD=1 ./scripts/deploy-k8s.sh              # 不自动启 port-forward（走 NodePort/Ingress 时用）
./scripts/deploy-k8s.sh -f /tmp/images-shanghai.txt     # 指定别的清单文件
```

---

## 8. 已知遗留（写给阅读代码的同事）

- **`migrate.ts` 外键顺序 bug**：MySQL 第一次 migration 会失败，脚本用 `SET GLOBAL FOREIGN_KEY_CHECKS=0` 绕过。修复方案是把 `skills` / `mcp_servers` 等父表的 `CREATE TABLE` 挪到 `agent_skills` / `agent_mcp_servers` 等子表前面。当前脚本里这步是 best-effort，不影响正常使用。
- **Ingress / 域名暴露**：当前 chart 只用 NodePort。生产上线时需要由运维分配域名 + TLS 证书 + 在 chart 里加 Ingress 资源。
- **trace MySQL 共享密码**：`siclawsiclawsiclaw` 写死在脚本里。生产建议用 Secret 管理。

---

有问题先看 §6（常见问题），还不行 ping 我（@yye）。
