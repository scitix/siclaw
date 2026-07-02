# platform/forge — 本地 Forgejo(L3 的 git forge 底座)

L3 平台化把 kbc 从「本地命令行工具」搬上网。底座 = 一个 **git forge(Forgejo)**,
它现成提供:网站 + git 存储 + issue(裁矛盾)/ PR(合并知识库改动)+ 多租户。
kbc 只在它之上造一座桥(`platform/forge_client.py` / `bridge.py` / `worker.py`),**不重写这些**。

详见 `design/L3-platform.md`。

## 起 / 停 / 清

```bash
docker compose -f platform/forge/docker-compose.yml up -d      # 起
docker compose -f platform/forge/docker-compose.yml down       # 停(留数据)
docker compose -f platform/forge/docker-compose.yml down -v    # 清(连数据一起删,回干净态)
```

## 访问 / 凭据(仅本地开发)

- Web: <http://localhost:3300>
- 管理员:`kbc` / `kbc-dev-2026`(邮箱 `kbc@local.dev`)
- 端口:web 3300(本机 3000/3001 被占)、ssh 2222

> ⚠️ 这是**一次性本地开发环境**,凭据写死在文档里。别拿这套配置上任何真环境。

## 首次初始化(起容器后跑一次)

见 `platform/forge/bootstrap.sh`:建管理员、建 API token、建测试仓 `aliyun-fc` 并推入冲突语料。
