// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract TreasuryVault {
    address public immutable CONTROLLER;

    error TreasuryVault__Unauthorized();
    error TreasuryVault__TransferFailed();

    event FundsDeposited(address indexed sender, uint256 amount);
    event FundsWithdrawn(address indexed target, uint256 amount);

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

    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }
}