# ZeroVault Treasury Protocol

**ZeroVault** is a security-first, modular Solidity treasury and multi-asset custody protocol built for Ethereum and EVM-compatible networks (designed to serve as the treasury backbone for the **Aervynx** ecosystem).

> **Core Security Principle:** Authorization, custody, scheduling, and execution are strictly separated responsibilities. Holding permission to request or queue an operation never grants the ability to move treasury assets immediately.

## Architecture Overview

ZeroVault replaces monolithic treasury contracts with isolated, single-responsibility modules connected through immutable references and one-time locked wiring:

```text
                       +------------------+
                       |   RoleManager    |  (RBAC + Last-Admin Protection)
                       +--------+---------+
                                |
        +-----------------------+-----------------------+
        v                       v                       v
+----------------+     +----------------+     +------------------+
| EmergencyPause |<----|    Timelock    |     | MultiSigGuardian |
| (Shared State) |     | (State Machine)|     | (M-of-N Recovery)|
+-------+--------+     +-------+--------+     +------------------+
        |                      |
        |                      v
        |             +----------------+     +------------------+
        +------------>|    Treasury    |<--->| BudgetController |
        |             | (Orchestrator) |     | (Epoch Spending) |
        |             +-------+--------+     +------------------+
        |                     |
        |                     v
        |             +----------------+     +------------------+
        +------------>| TreasuryVault  |<--->|  AssetRegistry   |
                      | (Multi-Asset)  |     |(ERC165/Cap/Freeze)|
                      +----------------+     +------------------+

  Satellite Protocol Modules (Isolated Custody & Pull-Payment):
  - CollateralLending  (ETH / ERC-20 / Genesis ERC-4907 NFT Loans + Grace Period & Dual Liquidation)
  - TreasuryVesting    (Token-Agnostic TGE, Cliff, Linear & Quarterly Schedules)
  - RevenueSplitter    (Pull-Payment ETH/ERC-20 Fee Distribution, Zero-Dust)
  - ZeroVaultGovernor  (OpenZeppelin DAO Governance + RuneToken ERC20Votes)
```

## Contract Inventory

| Category | Contract | Responsibility |
| :--- | :--- | :--- |
| **Core** | `contracts/core/Treasury.sol` | Main orchestration layer: ETH/ERC-20/ERC-721/ERC-1155 deposits, withdrawal request lifecycle, ERC-4907 rental orchestration, Timelock-gated execution, CEI, and `ReentrancyGuard`. |
| **Core** | `contracts/core/TreasuryVault.sol` | Custody-only vault for ETH, ERC-20, RWA (ERC-20), ERC-721, Hierarchical NFTs, and ERC-1155. One-time permanently locked `initializeController` eliminates circular deployment dependencies. Enforces `EmergencyPause` and `AssetRegistry` on both transfers and `onERC721Received`/`onERC1155Received` callbacks. |
| **Core** | `contracts/core/CollateralLending.sol` | Isolated installment lending module (1-12 installments) accepting ETH, whitelisted ERC-20, and Genesis ERC-721/ERC-4907 NFTs. Includes Grace Period, late fee, single-tx `repayFull`, automatic ERC-4907 utility preservation, and dual default liquidation (`liquidate` / `seizeToTreasury`). |
| **Core** | `contracts/core/TreasuryVesting.sol` | Token-agnostic vesting vault supporting TGE unlocks, cliffs, continuous linear or quarterly stepped releases, and Timelock-only revocation that preserves already-vested balances. |
| **Core** | `contracts/core/RevenueSplitter.sol` | Pull-payment ETH and ERC-20 revenue distributor using basis points (`10,000 = 100%`) with zero wei dust loss, DoS isolation against reverting recipients, and Timelock-gated split updates. |
| **Access** | `contracts/access/RoleManager.sol` | Centralized `AccessControlEnumerable` RBAC with zero-address guards and protection against revoking/renouncing the last `DEFAULT_ADMIN_ROLE`. |
| **Security** | `contracts/security/EmergencyPause.sol` | Shared protocol-wide pause registry queried by `Treasury`, `TreasuryVault`, `Timelock`, `TreasuryVesting`, `RevenueSplitter`, and `CollateralLending` to eliminate pause-bypass paths. |
| **Security** | `contracts/security/Timelock.sol` | Explicit 6-state operation machine (`None`, `Queued`, `Ready`, `Executed`, `Cancelled`, `Expired`), collision-resistant `abi.encode` IDs with `salt`, target allowlist, `1-30 day` delay, `14 day` grace period, and self-governed `setDelay`. |
| **Security** | `contracts/security/AssetRegistry.sol` | On-chain asset gatekeeper enforcing contract code checks, ERC-165 interface validation, strict allowlisting, per-asset withdrawal caps, and guardian-triggered per-asset freezes. |
| **Security** | `contracts/security/BudgetController.sol` | Rolling epoch spending limits (1 hour to 365 days) per asset to prevent split-withdrawal drain attacks. |
| **Security** | `contracts/security/MultiSigGuardian.sol` | M-of-N multi-signature controller for critical actions (`unpause`, role changes, asset unfreeze) with fast 1-of-N emergency pause and self-governed signer/threshold updates. |
| **Governance** | `contracts/governance/ZeroVaultGovernor.sol` | OpenZeppelin Governor (`GovernorSettings`, `GovernorVotes`, `GovernorVotesQuorumFraction`, `GovernorTimelockControl`) wired to `RuneToken` and real `Treasury`/`TreasuryVault`. |
| **Token** | `contracts/token/RuneToken.sol` | Governance & ecosystem ERC-20 (`RUNE`, 1B cap) with `ERC20Votes`, `ERC20Permit`, `ERC20Pausable`, and blacklist controls. |

## Permission Matrix

| Role | Permissions | Scope | Security Restrictions |
| :--- | :--- | :--- | :--- |
| **Public (Permissionless)** | Deposit ETH, vetted ERC-20, ERC-721, ERC-1155; repay loans; liquidate defaulted loans; distribute/claim pull-payment revenue | `Treasury`, `TreasuryVault`, `CollateralLending`, `RevenueSplitter` | Cannot withdraw treasury funds, queue/execute Timelock ops, modify configs, or pause/unpause. |
| **`OPERATOR_ROLE`** | Request withdrawals (`requestETHWithdrawal`, `requestERC20Withdrawal`), queue Timelock operations, seize defaulted loan collateral to Vault | `Treasury`, `Timelock`, `CollateralLending` | Cannot execute Timelock operations, bypass delay, grant roles, change delay, disable budgets, or unpause. |
| **`EXECUTOR_ROLE`** | Execute `Ready` Timelock operations after waiting period expires | `Timelock` | Cannot queue, cancel, modify delay, pause/unpause, or execute while paused. |
| **`GUARDIAN_ROLE`** | Activate global `pause()`, cancel queued Timelock ops & pending withdrawal requests, freeze individual assets (`freezeAsset`), revoke active ERC-4907 rentals (`revokeERC4907User`) | `EmergencyPause`, `Timelock`, `Treasury`, `AssetRegistry` | Cannot `unpause()`, `unfreezeAsset()`, withdraw assets, queue/execute operations, or manage roles. |
| **`BUDGET_MANAGER_ROLE`** | Register/vet assets & per-tx caps in `AssetRegistry`, configure epoch spending caps in `BudgetController`, configure lending collateral policies | `AssetRegistry`, `BudgetController`, `CollateralLending` | Cannot disable active epoch budgets (`disableBudget` is Admin-only), bypass Timelock, or move Vault funds. |
| **`DEFAULT_ADMIN_ROLE`** *(recommended: `MultiSigGuardian` / `Timelock`)* | Grant/revoke roles, `unpause()`, `unfreezeAsset()`, `disableBudget()`, one-time deployment wiring (`initializeController`, `initializeTarget`) | Protocol-wide | Cannot directly change Timelock `delay`, `allowedTargets`, or `RevenueSplitter` splits (must go through `Timelock`). Last admin cannot be removed or renounced. |

## Token & Multi-Asset Compatibility Policy

| Asset Class | Status | Handling & Security Controls |
| :--- | :--- | :--- |
| **Native ETH** | Supported | `Treasury.deposit()` / `receive()` forwards immediately to `TreasuryVault`; `Treasury` holds `0` stranded ETH. |
| **Standard & Non-Standard Return ERC-20** (e.g., USDC, DAI, USDT) | Supported | Handled via OpenZeppelin `SafeERC20`. |
| **RWA ERC-20** (e.g., ERC-3643 / Whitelisted T-Bills) | Supported (Vetted) | Registered as `AssetType.RWA_ERC20` in `AssetRegistry` with per-tx cap, epoch budget, and per-asset guardian freeze. Vault address must be whitelisted with the RWA issuer if KYC-gated. |
| **ERC-721 & Hierarchical NFTs** (e.g., ERC-7401 / ERC-6551 parent NFTs) | Supported (Vetted) | Verified on-chain via ERC-165 (`IERC721`). Direct `safeTransferFrom` deposits are gated inside `onERC721Received`. |
| **ERC-4907 Rental NFTs** | Supported (Vetted) | Vault retains permanent ownership (`ownerOf`) while granting time-bound `userOf` via Timelock, with instant guardian emergency revocation. |
| **ERC-1155** | Supported (Vetted) | Verified on-chain via ERC-165 (`IERC1155`); `onERC1155Received` and `onERC1155BatchReceived` enforce `AssetRegistry` vetting. |
| **Fee-on-Transfer Tokens** | **Explicitly Rejected** | Exact balance-delta check (`received == amount`) enforced on deposits, vesting funding, and lending collateral. |
| **Rebasing Tokens** | **Not Supported** | Pooled balance accounting assumes balances change only via explicit deposits and controlled withdrawals. |
| **Callback-Capable Tokens** (e.g., ERC-777) | Mitigated | All external-call paths are protected with `ReentrancyGuard` and Checks-Effects-Interactions (CEI). |

## Collateralized Lending & Default Resolution (`CollateralLending.sol`)

- **Isolated Collateral Escrow:** User collateral (ETH, ERC-20, Genesis NFTs) is strictly isolated from `TreasuryVault` reserves. Lending liquidity is capped to the pool funded via `Timelock`.
- **Oracle-Free Risk Bounds:** Each collateral asset has an explicit `maxLoanPerUnit` set by `BUDGET_MANAGER_ROLE`, eliminating flash-loan oracle manipulation risk.
- **Genesis NFT Utility Preservation:** If a locked Genesis NFT implements `ERC-4907`, `CollateralLending` automatically delegates `userOf` to the borrower until `nextDueTime + gracePeriod`, extends it on every installment payment, and lets it auto-expire on default.
- **3-Stage Missed-Installment Policy:**
  1. **Scheduled Installments (1-12)** plus single-transaction **`repayFull(loanId)`** (always allowed even during `EmergencyPause` so borrowers never unfairly default).
  2. **Grace Period + Late Fee:** Overdue installments enter a configurable `gracePeriod` with a fixed `lateFeeBps` before liquidation becomes eligible.
  3. **Dual Liquidation on Default:** Once `block.timestamp > nextDueTime + gracePeriod`, either (a) any liquidator calls `liquidate(loanId)` to repay remaining debt + late fee and claim the collateral, or (b) `OPERATOR_ROLE`/`DEFAULT_ADMIN_ROLE` calls `seizeToTreasury(loanId)` to transfer the defaulted collateral safely into `TreasuryVault`.

## Setup, Testing & Deployment

### Prerequisites

- Node.js `>= 18`
- Solidity `0.8.24` (EVM target: `cancun`)
- Hardhat `^2.22.6` and OpenZeppelin Contracts `^5.6.1`

### Install & Compile

```bash
npm install --legacy-peer-deps
npx hardhat clean
npx hardhat compile
```

### Run Test Suite (61 Tests / 230+ Fuzz & Stateful Scenarios)

```bash
# Run all unit, integration, governance, deployment, security, and fuzz tests
npx hardhat test

# Run protocol-wide fuzz & stateful scenario suite specifically
npx hardhat test test/ProtocolFuzzSuite.test.ts

# Generate full code coverage report
npx hardhat coverage
```

### Deterministic Deployment & Post-Deployment Verification

`scripts/deploy.ts` deploys all core contracts in dependency-safe order, locks one-time wiring (`initializeController` and `initializeTarget`), assigns separated roles, and runs strict post-deployment assertions (failing loudly on any mismatch):

```bash
# Dry-run deployment on local Hardhat network
npx hardhat run scripts/deploy.ts
```

Optional environment variables for separated production/testnet role assignment:

- `ADMIN_ADDRESS` (recommended: `MultiSigGuardian` or Gnosis Safe)
- `OPERATOR_ADDRESS`
- `EXECUTOR_ADDRESS`
- `GUARDIAN_ADDRESS`
- `BUDGET_MANAGER_ADDRESS`

## Security Notice

This codebase has been engineered with defense-in-depth patterns (RBAC, Timelock state machine, shared EmergencyPause, ReentrancyGuard, CEI, Pull-Payment, AssetRegistry, BudgetController, M-of-N MultiSigGuardian) and verified with 61 automated test suites including 230+ fuzz and invariant scenarios. However, it has **not yet undergone an independent third-party security audit** and should be audited prior to mainnet deployment with real funds.

## License

MIT — see [LICENSE](https://www.google.com/search?q=./LICENSE).
