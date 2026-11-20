// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "../core/Treasury.sol";
import "../core/TreasuryVault.sol";
import "../security/Timelock.sol";

/**
 * @notice Malicious recipient that attempts to re-enter Timelock and Treasury upon receiving ETH.
 */
contract ReentrancyAttacker {
    Treasury public immutable treasury;
    TreasuryVault public immutable vault;
    Timelock public immutable timelock;

    uint256 public attackCount;
    bool public timelockReentryBlocked;
    bool public treasuryReentryBlocked;

    uint256 public targetRequestId;
    uint256 public targetEta;
    bytes32 public targetSalt;

    constructor(address payable _treasury, address payable _vault, address payable _timelock) {
        treasury = Treasury(_treasury);
        vault = TreasuryVault(_vault);
        timelock = Timelock(_timelock);
    }

    function configureAttack(uint256 _requestId, uint256 _eta, bytes32 _salt) external {
        targetRequestId = _requestId;
        targetEta = _eta;
        targetSalt = _salt;
        attackCount = 0;
        timelockReentryBlocked = false;
        treasuryReentryBlocked = false;
    }

    receive() external payable {
        attackCount++;
        if (attackCount == 1) {
            bytes memory data = abi.encode(targetRequestId);
            try
                timelock.executeTransaction(
                    address(treasury),
                    0,
                    "executeWithdrawal(uint256)",
                    data,
                    targetEta,
                    targetSalt
                )
            {} catch {
                timelockReentryBlocked = true;
            }

            try treasury.executeWithdrawal(targetRequestId) {} catch {
                treasuryReentryBlocked = true;
            }
        }
    }
}

/**
 * @notice Recipient that unconditionally rejects ETH to verify atomic state rollback.
 */
contract RevertingReceiver {
    receive() external payable {
        revert("ETH rejected");
    }
}