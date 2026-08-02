// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "../security/EmergencyPause.sol";

contract EmergencyPauseMock is EmergencyPause {
    uint256 public value;

    constructor(address _roleManager) EmergencyPause(_roleManager) {}

    function testActionWhenNotPaused() external whenNotPaused {
        value = 42;
    }
}