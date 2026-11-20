// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/access/extensions/AccessControlEnumerable.sol";

/**
 * @title RoleManager
 * @author ZeroVault Lead Architect
 * @notice Centralized Role-Based Access Control (RBAC) for the ZeroVault Treasury Protocol.
 * @dev Separates administrative, operational, execution, budget, and emergency guardian duties.
 */
contract RoleManager is AccessControlEnumerable {
    /// @notice Role for treasury operators who can request withdrawals and queue operations.
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /// @notice Role for executors authorized to execute ready timelocked operations.
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");

    /// @notice Role for emergency guardians who can pause the system and cancel queued operations.
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    /// @notice Role for budget managers who manage asset/budget policies.
    bytes32 public constant BUDGET_MANAGER_ROLE = keccak256("BUDGET_MANAGER_ROLE");

    // Errors
    error RoleManager__InvalidInitialization();
    error RoleManager__ZeroAddress();
    error RoleManager__CannotRemoveLastAdmin();
    error RoleManager__MissingRole(address account, bytes32 role);

    /**
     * @notice Initializes RoleManager and grants DEFAULT_ADMIN_ROLE to the initial admin.
     * @param _admin The initial administrator address.
     */
    constructor(address _admin) {
        if (_admin == address(0)) revert RoleManager__InvalidInitialization();
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    /**
     * @notice Reverts if `account` does not hold `role`.
     */
    function checkRole(bytes32 role, address account) external view {
        if (!hasRole(role, account)) revert RoleManager__MissingRole(account, role);
    }

    function isAdmin(address account) external view returns (bool) {
        return hasRole(DEFAULT_ADMIN_ROLE, account);
    }

    function isOperator(address account) external view returns (bool) {
        return hasRole(OPERATOR_ROLE, account);
    }

    function isExecutor(address account) external view returns (bool) {
        return hasRole(EXECUTOR_ROLE, account);
    }

    function isGuardian(address account) external view returns (bool) {
        return hasRole(GUARDIAN_ROLE, account);
    }

    function isBudgetManager(address account) external view returns (bool) {
        return hasRole(BUDGET_MANAGER_ROLE, account);
    }

    /**
     * @dev Rejects granting any role to the zero address.
     */
    function _grantRole(bytes32 role, address account) internal virtual override returns (bool) {
        if (account == address(0)) revert RoleManager__ZeroAddress();
        return super._grantRole(role, account);
    }

    /**
     * @dev Prevents revoking or renouncing the last DEFAULT_ADMIN_ROLE holder.
     */
    function _revokeRole(bytes32 role, address account) internal virtual override returns (bool) {
        if (
            role == DEFAULT_ADMIN_ROLE &&
            hasRole(DEFAULT_ADMIN_ROLE, account) &&
            getRoleMemberCount(DEFAULT_ADMIN_ROLE) <= 1
        ) {
            revert RoleManager__CannotRemoveLastAdmin();
        }
        return super._revokeRole(role, account);
    }
}