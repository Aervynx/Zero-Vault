// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "../access/RoleManager.sol";

abstract contract EmergencyPause {
    RoleManager public immutable roleManager;
    bool private _paused;

    event Paused(address indexed account);
    event Unpaused(address indexed account);

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
        roleManager = RoleManager(_roleManager);
    }

    function paused() public view returns (bool) {
        return _paused;
    }

    function pause() external {
        if (!roleManager.hasRole(roleManager.GUARDIAN_ROLE(), msg.sender) && 
            !roleManager.hasRole(roleManager.DEFAULT_ADMIN_ROLE(), msg.sender)) {
            revert EmergencyPause__Unauthorized();
        }
        _paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external {
        if (!roleManager.hasRole(roleManager.DEFAULT_ADMIN_ROLE(), msg.sender)) {
            revert EmergencyPause__Unauthorized();
        }
        _paused = false;
        emit Unpaused(msg.sender);
    }
}