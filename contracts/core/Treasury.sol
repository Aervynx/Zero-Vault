// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "../security/EmergencyPause.sol";
import "../access/RoleManager.sol";
import "./TreasuryVault.sol";

contract Treasury is EmergencyPause {
    TreasuryVault public immutable vault;
    address public immutable timelock;

    event Withdrawn(address indexed target, uint256 amount);
    event ERC20Withdrawn(address indexed token, address indexed target, uint256 amount);
    event Deposited(address indexed sender, uint256 amount);

    error Treasury__Unauthorized();
    error Treasury__InvalidTimelock();
    error Treasury__ZeroDeposit();
    error Treasury__ZeroAddress();
    error Treasury__TransferFailed();

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
        (bool success, ) = payable(address(vault)).call{value: msg.value}("");
        if (!success) revert Treasury__TransferFailed();
        emit Deposited(msg.sender, msg.value);
    }

    function withdraw(address payable _to, uint256 _amount) external onlyTimelock whenNotPaused {
        if (_to == address(0)) revert Treasury__ZeroAddress();
        vault.transferETH(_to, _amount);
        emit Withdrawn(_to, _amount);
    }

    function withdrawERC20(address _token, address _to, uint256 _amount) external onlyTimelock whenNotPaused {
        if (_token == address(0) || _to == address(0)) revert Treasury__ZeroAddress();
        vault.transferERC20(_token, _to, _amount);
        emit ERC20Withdrawn(_token, _to, _amount);
    }

    receive() external payable {
        if (msg.value > 0) {
            (bool success, ) = payable(address(vault)).call{value: msg.value}("");
            if (!success) revert Treasury__TransferFailed();
            emit Deposited(msg.sender, msg.value);
        }
    }
}