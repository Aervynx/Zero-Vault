// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "../access/RoleManager.sol";

/**
 * @title EmergencyPause
 * @author ZeroVault Lead Architect
 * @notice Shared protocol-wide emergency pause registry for ZeroVault.
 * @dev Allows GUARDIAN_ROLE or DEFAULT_ADMIN_ROLE to pause, and restricts unpause strictly to DEFAULT_ADMIN_ROLE.
 *      Designed to be deployed once and queried by Treasury, TreasuryVault, and Timelock so pause cannot be bypassed.
 */
contract EmergencyPause {
    RoleManager public immutable roleManager;
    bool private _paused;

    event Paused(address indexed account);
    event Unpaused(address indexed account);

    error EmergencyPause__ZeroAddress();
    error EmergencyPause__EnforcedPause();
    error EmergencyPause__ExpectedPause();
    error EmergencyPause__Unauthorized();

    modifier whenNotPaused() {
        if (_paused) revert EmergencyPause__EnforcedPause();
        _;
    }

    modifier whenPaused() {
        if (!_paused) revert EmergencyPause__ExpectedPause();
        _;
    }

    constructor(address _roleManager) {
        if (_roleManager == address(0)) revert EmergencyPause__ZeroAddress();
        roleManager = RoleManager(_roleManager);
    }

    /**
     * @notice Returns true if the protocol is currently paused.
     */
    function paused() public view returns (bool) {
        return _paused;
    }

    /**
     * @notice Reverts with EmergencyPause__EnforcedPause if the protocol is paused.
     * @dev Called by Treasury, TreasuryVault, and Timelock to enforce a single pause source of truth.
     */
    function requireNotPaused() external view {
        if (_paused) revert EmergencyPause__EnforcedPause();
    }

    /**
     * @notice Reverts with EmergencyPause__ExpectedPause if the protocol is not paused.
     */
    function requirePaused() external view {
        if (!_paused) revert EmergencyPause__ExpectedPause();
    }

    /**
     * @notice Activates emergency pause. Callable by GUARDIAN_ROLE or DEFAULT_ADMIN_ROLE.
     */
    function pause() external whenNotPaused {
        if (!roleManager.isGuardian(msg.sender) && !roleManager.isAdmin(msg.sender)) {
            revert EmergencyPause__Unauthorized();
        }
        _paused = true;
        emit Paused(msg.sender);
    }

    /**
     * @notice Deactivates emergency pause. Callable strictly by DEFAULT_ADMIN_ROLE.
     */
    function unpause() external whenPaused {
        if (!roleManager.isAdmin(msg.sender)) {
            revert EmergencyPause__Unauthorized();
        }
        _paused = false;
        emit Unpaused(msg.sender);
    }
}