# SingleSpark 合约审计 skills 验证报告

日期：2026-10-14。对象为当前本地工作树，基线提交 `55efc39e947472c5a0ae889d46e07800e4a471a6`，包含审计前已有的未提交资金逻辑修改。源码和构建配置摘要见 [source-manifest.json](source-manifest.json)。

本轮确认 **1 项条件性中风险治理阻塞问题**，复现 **1 项已记录的低风险插件分配精度限制**；没有确认 Critical / High。Solana 依赖检查另有三项告警。这些结论限定于本轮源码、工具和检查范围，不能用于证明当前链上部署安全或批准主网上线。

## 范围与使用的 skills

| 功能 | 链与平台 | 检查对象 |
| --- | --- | --- |
| 收入托管、插件分配、Claim、治理 | ARC / Argus | Vault、factory、router、plugins 及共享治理依赖 |
| 通用玩法和兑换 | 共享 EVM；Robinhood Testnet / Pons | Gameplay Vault、factory、asset、plugins、V4 adapter、Pons curve/graduation 路径 |
| 平台 NFT 收入与质押 | Robinhood Testnet；不属于 launchpad | 独立 NFT、收入 Vault、factory 和历史 epoch 结算 |
| PDA 托管、玩法、DAO、延迟升级 | Solana / Pump | revenue、DAO、timelock、shared helpers、legacy ABI |

使用公开 skill 的实际文件和关联清单；没有全局安装这些 skills。下载内容的 SHA-256 保存在 source manifest 中。

- [Trail of Bits skills](https://github.com/trailofbits/skills)：secure-workflow-guide 和 solana-vulnerability-scanner；执行 Slither、权限/继承输出、资金不变量检查和 Solana 六类检查。
- [EVM audit skills](https://github.com/austintgriffith/evm-audit-skills)：general、precision-math、ERC20、AMM、signatures、governance、access-control、DoS、ERC721、proxies。按领域并行复核后合并结果；本环境没有该 skill 指定的 Opus 子模型，使用当前代理模型。
- [Solana security skill](https://github.com/1DanWave2/solana-security-skill)：先确定参与者与资金不变量，再检查账户、PDA/CPI、金额、token 扩展、测试缺口与报告。

未全面重审外部 Argus Portal、Pump、Pons、Uniswap 或 OpenZeppelin；它们的固定身份和调用边界属于本轮检查范围，其完整实现不属于本轮完整审计范围。前后端、基础设施、真实钱包和历史签名 journal 未纳入完整审计。

## [M-01] 零持币者可以占用旧治理 Treasury 的唯一提案槽

**Severity**: Medium（条件性）  
**Category**: evm-audit-governance / evm-audit-dos  
**Location**: [ArcProjectTreasury.sol](../../../chains/evm/governance/ArcProjectTreasury.sol#L92)，`propose()` / `settle()`；Argus Governance 继承该逻辑。

**Description**: 提案不要求持币、锁仓或保证金，却占用唯一 `activeProposal`，并在固定七天投票期内预留预算。没有提前否决或取消入口。任何地址都能用无意义的 quote hash 抢占提案槽，阻止正常提案七天。到期结算后，若再次抢先提交，可续期阻塞。攻击者不能因此提走 Treasury 资金；持续阻塞需要持续赢得新提案竞争。

适用前提是该治理组件已经绑定、启用并拥有资金。本轮没有建立在线已注资治理实例受影响的证据；当前加权 Argus 新收入不分配到 community bucket，不能据此声称线上 Claim 正在受攻击。历史实例或直接注资的治理组件仍需按其实际绑定核对。开放提案本身是已记录政策，修改准入方式需要明确产品选择。

**Proof of Concept**: [AuditProjectTreasurySpam.t.sol](../../../chains/arc/launchpads/argus/test/AuditProjectTreasurySpam.t.sol#L7) 给 Treasury 注入 300 USDC，确认 spammer 零持币；spammer 提交全额 Boost 申请，正常 TokenInfo 提案被拒绝。七天后无投票结算释放预算，再次提交仍可占用。连续两轮通过，资金全部留在 Treasury。

**Recommendation**: 在启用并注资此路径前，明确提案抗垃圾策略，例如需锁定的提案 stake、可罚没保证金或持有人提前否决。现有不可变部署不能通过配置静默修复，也不能将重部署视为迁资。

## [L-01] 极小收入分笔会累计偏向最后一个插件

**Severity**: Low（已记录的精度限制）  
**Category**: evm-audit-precision-math  
**Location**: [ArgusRevenueVault.sol](../../../chains/arc/launchpads/argus/ArgusRevenueVault.sol#L223)，`_allocatePlugins()`；[GameplayVault.sol](../../../chains/evm/gameplay/GameplayVault.sol#L153)，`_allocate()`。

**Description**: 顶层 10% / 0.5% / 89.5% 的跨笔进位已有处理，但插件层每次独立向下舍入，余数全部归最后一个启用插件。相同的累计收入，分笔方式不同会产生不同插件余额。此政策已在 EVM 文档中说明；本轮将其归为精度观察项，没有证明获利盗取或突破隔离预算。

**Proof of Concept**: 等权 1:1:1、总收入 200 个最小单位，两种情况均有 platform=20、Claim=1、work=179：

| 入账方式 | 插件 1 | 插件 2 | 插件 3 |
| --- | ---: | ---: | ---: |
| 一次 200 单位 | 59 | 59 | 61 |
| 200 次各 1 单位 | 0 | 0 | 179 |

[ARC 回归](../../../chains/arc/launchpads/argus/test/AuditWeightedRounding.t.sol#L10) 和 [共享 EVM 回归](../../../chains/evm/gameplay/test/GameplayAllocationAudit.t.sol#L9) 均通过。测试确认当前行为，并非修复后的通过证明。

三个启用插件时，每次分配给末尾插件的额外舍入份额小于两个资金最小单位。ARC USDC6 是每次小于 0.000002 USDC；当前 Pons 原生 ETH 路径是尘额。`sync()` 一次记入全部尚未入账余额，攻击者不能靠重复空调用拆分已经存在的大笔收入；复现需要极小捐款或真实极小收入事件。

**Recommendation**: 如果要求权重代表严格的长期累计份额，应在固定权重期间累计插件分数余数，并明确定义延迟权重变更时的处理；旧余额不能被重新分配。如果接受现有舍入政策，应保留此测试和精度说明，并在支持粗粒度资产前重新评估。

## 实际运行结果

| 检查 | 结果 |
| --- | --- |
| `npm run check:architecture` | 通过 |
| `npm run test:contracts` 最终回归 | EVM 333 次测试执行通过；Rust 15 项通过；Solana 客户端 6 项通过 |
| `npm --prefix SingleSparkContract run test:tools` | 19 项通过 |
| 四个 EVM profile 的 `forge build --sizes` | ARC、共享 EVM、Pons、平台 NFT 均通过 |
| 显式安全 Clippy | exit 0，有警告；生产 arithmetic/unwrap 警告逐项核对边界，见 Solana 分报告 |
| Cargo Audit 0.22.2 | 237 个锁定依赖，0 条 vulnerability，3 条警告，见下文 |
| Slither 0.11.6 | 四组扫描 `success=true`，102 detectors；原始告警须经人工判断 |

EVM 最终执行数为 legacy 1、ARC 257、共享 EVM 38、Pons 22、平台 NFT 15。两个新 ARC 测试复用既有测试类，带来 21 次继承用例重复执行；本轮新增独立场景为三个 EVM 场景和六个 Rust 场景。既有 Foundry 金额守恒/分笔费用/NFT 守恒 fuzz 测试也随完整套件运行。没有运行 Echidna 或形式化验证。

构建中 ArgusRevenueVault runtime 为 20,830 bytes、PonsGameplayVault 14,527 bytes、PlatformNftRevenueVault 8,178 bytes；这是当前编译配置下的本地结果，不是链上代码匹配证明。

Slither 原始输出：ARC 163、共享 EVM 35、Pons 66、平台 NFT 15，共 279 条，包含跨路径重复项和与资金逻辑无关的提示。其 High/Medium 是检测器级别，不等同于确认漏洞。复核了调用权限、nonReentrant、active plugin phase、实际余额差、失败回滚、固定兑换目标、时间锁和默认零初始化。详细分类见 [ARC triage](slither-triage-arc.md) 与 [EVM/Pons/NFT triage](slither-triage-evm.md)。没有因扫描器标为 High 就直接声称资金可被盗取。

ARC 的 Low/Informational 未逐条裁决。SingleSpark strategy 接受直接原生币转账但没有 sweep，这一 unsupported deposit 限制保留在 triage 中：正常 V4 收费直接领取到 launcher，不经过该余额；不要直接向 strategy 转账。本轮没有为此增加任意提款权限。

ARC/Pons 的 Foundry 编译产物使用跨根源路径，直接扫描最初无法定位共享 EVM 文件。最终用临时路径别名和独立 build-info 完成扫描，没有修改生产源码、remapping 或部署配置。共享 EVM/NFT 初次产物包含部分 forge-std 符号解析告警，不能把成功扫描视为完整测试调用图验证。Pons 的 inheritance graph、function summary、vars-and-auth 输出保存在证据包中；DOT 未渲染为图片。

## Solana 与依赖告警

Solana 六类覆盖结果：arbitrary CPI、PDA、owner、signer 四项 clear；旧版 sysvar spoofing 不适用于固定的 solana-program 2.3.0；代码没有指令 introspection，因此最后一项 n/a。逐项证据、参与者、不变量、instruction walkthrough、Clippy 警告和剩余测试缺口见 [Solana 分报告](solana-review.md)。本轮 clear 仅表示已检查路径未发现对应问题。

最新 RustSec 数据库 commit `6aed84668c23d7f535077a9fe918bf1fa0f6a5bc`，更新时间 2026-10-13。Cargo Audit 的三项警告为：

- `bincode 1.3.3`：[RUSTSEC-2025-0141](https://rustsec.org/advisories/RUSTSEC-2025-0141.html)，停止维护。
- `libsecp256k1 0.6.0`：[RUSTSEC-2025-0161](https://rustsec.org/advisories/RUSTSEC-2025-0161.html)，停止维护。
- `rand 0.7.3`：[RUSTSEC-2026-0097](https://rustsec.org/advisories/RUSTSEC-2026-0097.html)，特定自定义 logger/RNG 重入条件下 unsound。当前 host feature tree 缺少必需的 rand/log，审阅源码没有对应自定义 logger；未证明存在链上利用路径。仍需在 SDK 升级与 SBF 目标特性评估时跟踪。

本轮没有更改固定 Solana SDK 或锁文件。host Rust 测试检查账户验证，不能替代 SBF 的真实 CPI/原子回滚检查；本机 PATH 未提供 cargo-build-sbf，本轮未运行 split SBF 构建或本地 validator 集成。

## 交付与后续边界

仅新增四份独立审计测试和本目录报告/证据；审计前的生产修改、配置、部署 pins 和签名 journal 均保留。没有修复生产合约、部署、广播交易、推送代码或公开 GitHub 漏洞 issue。

详细结果：[ARC/Argus](argus-review.md)、[EVM/Pons/NFT](evm-review.md)、[Solana](solana-review.md)。机器摘要见 [audit-summary.json](audit-summary.json)，原始日志、静态分析 JSON 和图输出见 [evidence.zip](evidence.zip)。

建议先核对 M-01 对应治理组件是否确实启用并有资金，再决定准入策略；L-01 可按现有精度政策评估。当前源码硬化不会更新不可变部署或自动迁资；下一步上线判断需要单独核对部署字节码、生产 48 小时控制器、实际钱包流程与未覆盖的 SBF 集成。NFT 真实七天周期领取在现有公共记录中仍是未验收状态。
