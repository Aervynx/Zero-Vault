// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title RoleManager
 * @author ZeroVault Lead Architect
 * @notice Centralized Role-Based Access Control (RBAC) for the ZeroVault Treasury Protocol.
 * @dev Manages roles and permissions across the protocol using OpenZeppelin's AccessControl.
 */
contract RoleManager is AccessControl {
    // Roles

    /// @notice Role for treasury operators who can execute routine actions.
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /// @notice Role for the emergency guardian who can trigger security pauses.
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    /// @notice Role for budget managers who allocate budgets.
    bytes32 public constant BUDGET_MANAGER_ROLE = keccak256("BUDGET_MANAGER_ROLE");

    // Errors
    error RoleManager__InvalidInitialization();

    // Constructor

    /**
     * @notice Initializes the RoleManager contract and sets up the deployer as the default admin.
     * @param _admin The address to be granted the DEFAULT_ADMIN_ROLE.
     */
    constructor(address _admin) {
        if (_admin == address(0)) revert RoleManager__InvalidInitialization();
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }
}