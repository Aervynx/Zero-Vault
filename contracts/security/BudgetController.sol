// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "../access/RoleManager.sol";

/**
 * @title BudgetController
 * @author ZeroVault Lead Architect
 * @notice Enforces per-asset rolling epoch spending limits (daily/weekly/monthly) for ZeroVault Treasury.
 * @dev Prevents split-withdrawal attacks where an operator queues multiple smaller withdrawals
 *      to bypass a single-transaction cap.
 */
contract BudgetController {
    struct EpochBudget {
        uint256 limit;
        uint256 epochDuration;
        uint256 epochStart;
        uint256 spentInEpoch;
        bool active;
    }

    RoleManager public immutable roleManager;
    address public treasury;
    bool public treasuryInitialized;

    uint256 public constant MIN_EPOCH_DURATION = 1 hours;
    uint256 public constant MAX_EPOCH_DURATION = 365 days;

    // asset == address(0) represents native ETH / gas coin
    mapping(address => EpochBudget) public budgets;

    event TreasuryBound(address indexed treasury);
    event BudgetConfigured(
        address indexed asset,
        uint256 limit,
        uint256 epochDuration,
        uint256 epochStart,
        address indexed configuredBy
    );
    event BudgetDisabled(address indexed asset, address indexed disabledBy);
    event BudgetConsumed(
        address indexed asset,
        uint256 amount,
        uint256 spentInEpoch,
        uint256 limit,
        uint256 epochStart
    );

    error BudgetController__ZeroAddress();
    error BudgetController__Unauthorized();
    error BudgetController__TreasuryAlreadySet();
    error BudgetController__InvalidLimit();
    error BudgetController__InvalidEpochDuration();
    error BudgetController__EpochLimitExceeded(address asset, uint256 attemptedTotal, uint256 limit);

    modifier onlyTreasury() {
        if (!treasuryInitialized || msg.sender != treasury) {
            revert BudgetController__Unauthorized();
        }
        _;
    }

    constructor(address _roleManager) {
        if (_roleManager == address(0)) revert BudgetController__ZeroAddress();
        roleManager = RoleManager(_roleManager);
    }

    /**
     * @notice Permanently binds this BudgetController to the Treasury contract (one-time setup).
     */
    function initializeTreasury(address _treasury) external {
        if (!roleManager.isAdmin(msg.sender)) revert BudgetController__Unauthorized();
        if (treasuryInitialized) revert BudgetController__TreasuryAlreadySet();
        if (_treasury == address(0)) revert BudgetController__ZeroAddress();

        treasury = _treasury;
        treasuryInitialized = true;
        emit TreasuryBound(_treasury);
    }

    /**
     * @notice Configures or updates an epoch spending cap for an asset (address(0) for native ETH).
     * @dev Callable by BUDGET_MANAGER_ROLE or DEFAULT_ADMIN_ROLE.
     */
    function configureBudget(address asset, uint256 limit, uint256 epochDuration) external {
        if (!roleManager.isBudgetManager(msg.sender) && !roleManager.isAdmin(msg.sender)) {
            revert BudgetController__Unauthorized();
        }
        if (limit == 0) revert BudgetController__InvalidLimit();
        if (epochDuration < MIN_EPOCH_DURATION || epochDuration > MAX_EPOCH_DURATION) {
            revert BudgetController__InvalidEpochDuration();
        }

        EpochBudget storage b = budgets[asset];
        uint256 currentSpent = 0;
        uint256 start = block.timestamp;

        // Preserve current epoch spend if already active and within the same window
        if (b.active && block.timestamp < b.epochStart + b.epochDuration) {
            currentSpent = b.spentInEpoch;
            start = b.epochStart;
        }

        budgets[asset] = EpochBudget({
            limit: limit,
            epochDuration: epochDuration,
            epochStart: start,
            spentInEpoch: currentSpent,
            active: true
        });

        emit BudgetConfigured(asset, limit, epochDuration, start, msg.sender);
    }

    /**
     * @notice Disables the epoch cap for an asset. Strictly restricted to DEFAULT_ADMIN_ROLE.
     */
    function disableBudget(address asset) external {
        if (!roleManager.isAdmin(msg.sender)) revert BudgetController__Unauthorized();
        budgets[asset].active = false;
        emit BudgetDisabled(asset, msg.sender);
    }

    /**
     * @notice Records spending against the asset's current epoch budget. Callable only by Treasury.
     */
    function consumeBudget(address asset, uint256 amount) external onlyTreasury {
        EpochBudget storage b = budgets[asset];
        if (!b.active) return;

        if (block.timestamp >= b.epochStart + b.epochDuration) {
            uint256 elapsedEpochs = (block.timestamp - b.epochStart) / b.epochDuration;
            b.epochStart += elapsedEpochs * b.epochDuration;
            b.spentInEpoch = 0;
        }

        uint256 newSpent = b.spentInEpoch + amount;
        if (newSpent > b.limit) {
            revert BudgetController__EpochLimitExceeded(asset, newSpent, b.limit);
        }

        b.spentInEpoch = newSpent;
        emit BudgetConsumed(asset, amount, newSpent, b.limit, b.epochStart);
    }

    /**
     * @notice View-only check used during withdrawal request creation to fail fast if over budget.
     */
    function previewConsume(address asset, uint256 amount) external view {
        EpochBudget storage b = budgets[asset];
        if (!b.active) return;

        uint256 effectiveSpent = block.timestamp >= b.epochStart + b.epochDuration
            ? 0
            : b.spentInEpoch;

        if (effectiveSpent + amount > b.limit) {
            revert BudgetController__EpochLimitExceeded(asset, effectiveSpent + amount, b.limit);
        }
    }

    /**
     * @notice Returns remaining spendable amount in the current epoch (returns max uint256 if inactive).
     */
    function remainingBudget(address asset) external view returns (uint256) {
        EpochBudget storage b = budgets[asset];
        if (!b.active) return type(uint256).max;

        uint256 effectiveSpent = block.timestamp >= b.epochStart + b.epochDuration
            ? 0
            : b.spentInEpoch;

        if (effectiveSpent >= b.limit) return 0;
        return b.limit - effectiveSpent;
    }
}