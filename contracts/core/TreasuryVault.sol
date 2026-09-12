// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract TreasuryVault {
    using SafeERC20 for IERC20;

    address public immutable CONTROLLER;

    error TreasuryVault__Unauthorized();
    error TreasuryVault__TransferFailed();

    event FundsDeposited(address indexed sender, uint256 amount);
    event FundsWithdrawn(address indexed target, uint256 amount);
    event ERC20FundsWithdrawn(address indexed token, address indexed target, uint256 amount);

    modifier onlyController() {
        if (msg.sender != CONTROLLER) revert TreasuryVault__Unauthorized();
        _;
    }

    constructor(address _controller) {
        CONTROLLER = _controller;
    }

    receive() external payable {
        emit FundsDeposited(msg.sender, msg.value);
    }

    function transferETH(address payable _to, uint256 _amount) external onlyController {
        (bool success, ) = _to.call{value: _amount}("");
        if (!success) revert TreasuryVault__TransferFailed();
        emit FundsWithdrawn(_to, _amount);
    }

    function transferERC20(address _token, address _to, uint256 _amount) external onlyController {
        IERC20(_token).safeTransfer(_to, _amount);
        emit ERC20FundsWithdrawn(_token, _to, _amount);
    }

    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }

    function getERC20Balance(address _token) external view returns (uint256) {
        return IERC20(_token).balanceOf(address(this));
    }
}