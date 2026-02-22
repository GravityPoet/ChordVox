# AriaKey 授权销售流程（内部使用，不对外运营说明）

> [!WARNING]
> 本文档仅供 AriaKey 内部运营与技术团队使用。  
> 不得直接提供给客户，不用于公开页面、公开售卖说明或 Release 宣传文案。
>
> Internal use only.  
> Do not expose this document as customer-facing operating guidance.

本文是卖家视角的最小可落地流程：客户付款 -> 自动发码 -> 客户在桌面端激活。

## 1) 基础组件

- 桌面端：AriaKey（已内置激活/校验调用）
- 授权服务：`services/license-server`
- 支付平台：Stripe / Lemon Squeezy / Paddle（任选）
- 发信服务：Resend / SendGrid / Postmark（任选）

## 2) 数据流

1. 客户在你的网站完成付款。
2. 支付平台 webhook 通知你的后端（订单成功）。
3. 后端调用发码逻辑（等价于 `npm run admin -- issue ...`）。
4. 后端将授权码写入数据库，并给客户发邮件。
5. 客户在 AriaKey 的 `设置 -> 账户 -> 桌面授权` 输入授权码激活。
6. 客户端定期调用 `validate`，你可撤销/退款后失效。

## 3) 客户端配置（必须）

在 AriaKey 的运行环境中配置：

```bash
LICENSE_API_BASE_URL=https://license.your-domain.com
LICENSE_PRODUCT_ID=ariakey-pro
LICENSE_OFFLINE_GRACE_HOURS=168
LICENSE_ALLOW_DEV_KEYS=false
```

## 4) 授权码生成（卖家）

手动发码（运营后台可先用命令行）：

```bash
cd services/license-server
npm run admin -- issue --email buyer@example.com --order ord_123 --days 365 --max 2
```

撤销（退款/风控）：

```bash
npm run admin -- revoke --key AK-XXXX-XXXX-XXXX-XXXX --reason "Refunded"
```

## 5) 推荐商品策略

- 个人版：`max=1`
- 专业版：`max=2` 或 `max=3`
- 团队版：通过后台发多个 key 或按席位批量发码

## 6) 运营规则建议

- 丢码：允许按订单号查询并重发。
- 换机：可手动提升 `max_activations` 或后台解除旧机器绑定。
- 退款：立即 `revoke`，下次客户端校验后失效。

## 7) 账号登录要可用（可选）

AriaKey 的账号模块依赖 `VITE_NEON_AUTH_URL`。如果你希望“账号登录”也启用，需要提供兼容 Better Auth / Neon Auth 的服务端并配置：

```bash
VITE_NEON_AUTH_URL=https://auth.your-domain.com
VITE_OPENWHISPR_API_URL=https://api.your-domain.com
VITE_OPENWHISPR_OAUTH_CALLBACK_URL=https://app.your-domain.com/?panel=true
```

如果你暂时只卖“授权激活版”，可以先不上账号系统，仅保留桌面授权激活流程。

## 8) 客户安装遇到「已损坏 / 无法验证」弹窗（macOS）

当你还没做 Apple Notarization（公证）时，这是常见现象，不是应用真的损坏。

给客户统一回复这 3 步：

1. 把 `AriaKey.app` 拖到 `Applications`。
2. 在 `Applications` 里右键 `AriaKey.app` -> **打开**。
3. 若仍被拦截，在终端执行：

```bash
xattr -dr com.apple.quarantine /Applications/AriaKey.app
open /Applications/AriaKey.app
```
