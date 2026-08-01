// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "./TreasuryVault.sol";
import "../access/RoleManager.sol";

contract Treasury {
    TreasuryVault public immutable vault;
    RoleManager public immutable roleManager;

    event Withdrawn(address indexed target, uint256 amount);

    error Treasury__Unauthorized();
    error Treasury__TransferFailed();

    constructor(address _vault, address _roleManager) {
        vault = TreasuryVault(payable(_vault));
        roleManager = RoleManager(_roleManager);
    }

    function withdraw(address payable _to, uint256 _amount) external {
        if (!roleManager.hasRole(roleManager.OPERATOR_ROLE(), msg.sender)) {
            revert Treasury__Unauthorized();
        }

        vault.transferETH(_to, _amount);
        emit Withdrawn(_to, _amount);
    }

    receive() external payable {}
}