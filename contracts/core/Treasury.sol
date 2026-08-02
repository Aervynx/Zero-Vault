// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "../security/EmergencyPause.sol";
import "../access/RoleManager.sol";
import "./TreasuryVault.sol";

contract Treasury is EmergencyPause {
    TreasuryVault public immutable vault;
    address public immutable timelock;

    event Withdrawn(address indexed target, uint256 amount);
    event Deposited(address indexed sender, uint256 amount);

    error Treasury__Unauthorized();
    error Treasury__TransferFailed();
    error Treasury__InvalidTimelock();
    error Treasury__ZeroDeposit();

    modifier onlyTimelock() {
        if (msg.sender != timelock) revert Treasury__Unauthorized();
        _;
    }

    constructor(
        address _vault, 
        address _roleManager, 
        address _timelock
    ) EmergencyPause(_roleManager) {
        if (_timelock == address(0)) revert Treasury__InvalidTimelock();
        vault = TreasuryVault(payable(_vault));
        timelock = _timelock;
    }

    function deposit() external payable {
        if (msg.value == 0) revert Treasury__ZeroDeposit();
        emit Deposited(msg.sender, msg.value);
    }

    function withdraw(address payable _to, uint256 _amount) external onlyTimelock whenNotPaused {
        vault.transferETH(_to, _amount);
        emit Withdrawn(_to, _amount);
    }

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }
}