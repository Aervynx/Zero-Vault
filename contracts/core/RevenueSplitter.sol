// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../security/EmergencyPause.sol";

/**
 * @title RevenueSplitter
 * @author ZeroVault Lead Architect
 * @notice Pull-payment protocol revenue splitter for ETH and ERC20 fees (e.g., DeliveryEscrow,
 *         Fleet Profit Pools, and TreasuryVault). Prevents recipient DoS and reentrancy.
 */
contract RevenueSplitter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Split {
        address recipient;
        uint16 bps; // Basis points out of 10_000 (e.g., 5000 = 50%)
    }

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_RECIPIENTS = 20;

    EmergencyPause public immutable emergencyPause;
    address public immutable timelock;

    Split[] private _splits;

    uint256 public totalPendingETH;
    mapping(address => uint256) public pendingETH;

    mapping(address => uint256) public totalPendingERC20;
    mapping(address => mapping(address => uint256)) public pendingERC20;

    event ETHReceived(address indexed sender, uint256 amount);
    event ETHDistributed(uint256 amount);
    event ERC20Distributed(address indexed token, uint256 amount);
    event ETHClaimed(address indexed recipient, uint256 amount);
    event ERC20Claimed(address indexed token, address indexed recipient, uint256 amount);
    event SplitsUpdated(uint256 recipientCount);

    error RevenueSplitter__ZeroAddress();
    error RevenueSplitter__Unauthorized();
    error RevenueSplitter__InvalidSplits();
    error RevenueSplitter__DuplicateRecipient(address recipient);
    error RevenueSplitter__NothingToDistribute();
    error RevenueSplitter__NothingToClaim();
    error RevenueSplitter__TransferFailed();

    constructor(address _emergencyPause, address _timelock, Split[] memory _initialSplits) {
        if (_emergencyPause == address(0) || _timelock == address(0)) {
            revert RevenueSplitter__ZeroAddress();
        }
        emergencyPause = EmergencyPause(_emergencyPause);
        timelock = _timelock;
        _setSplits(_initialSplits);
    }

    receive() external payable {
        if (msg.value > 0) {
            emit ETHReceived(msg.sender, msg.value);
        }
    }

    function getSplits() external view returns (Split[] memory) {
        return _splits;
    }

    /**
     * @notice Updates revenue split recipients and percentages. Strictly gated by Timelock.
     */
    function updateSplits(Split[] calldata _newSplits) external {
        if (msg.sender != timelock) revert RevenueSplitter__Unauthorized();
        _setSplits(_newSplits);
    }

    /**
     * @notice Allocates newly received ETH among configured recipients (accounting-only, DoS-safe).
     */
    function distributeETH() external {
        uint256 balance = address(this).balance;
        if (balance <= totalPendingETH) revert RevenueSplitter__NothingToDistribute();

        uint256 distributable = balance - totalPendingETH;
        uint256 len = _splits.length;
        uint256 allocated = 0;

        for (uint256 i = 0; i < len; i++) {
            uint256 share = (i == len - 1)
                ? (distributable - allocated)
                : (distributable * _splits[i].bps) / BPS_DENOMINATOR;
            allocated += share;
            pendingETH[_splits[i].recipient] += share;
        }

        totalPendingETH += distributable;
        emit ETHDistributed(distributable);
    }

    /**
     * @notice Allocates newly received ERC20 tokens among configured recipients (accounting-only, DoS-safe).
     */
    function distributeERC20(address _token) external {
        if (_token == address(0)) revert RevenueSplitter__ZeroAddress();

        uint256 balance = IERC20(_token).balanceOf(address(this));
        uint256 pendingTotal = totalPendingERC20[_token];
        if (balance <= pendingTotal) revert RevenueSplitter__NothingToDistribute();

        uint256 distributable = balance - pendingTotal;
        uint256 len = _splits.length;
        uint256 allocated = 0;

        for (uint256 i = 0; i < len; i++) {
            uint256 share = (i == len - 1)
                ? (distributable - allocated)
                : (distributable * _splits[i].bps) / BPS_DENOMINATOR;
            allocated += share;
            pendingERC20[_token][_splits[i].recipient] += share;
        }

        totalPendingERC20[_token] += distributable;
        emit ERC20Distributed(_token, distributable);
    }

    /**
     * @notice Pull-payment claim for allocated ETH. Callable for any recipient while unpaused.
     */
    function claimETH(address payable _recipient) external nonReentrant {
        emergencyPause.requireNotPaused();
        if (_recipient == address(0)) revert RevenueSplitter__ZeroAddress();

        uint256 amount = pendingETH[_recipient];
        if (amount == 0) revert RevenueSplitter__NothingToClaim();

        // CEI: deduct balances before external transfer
        pendingETH[_recipient] = 0;
        totalPendingETH -= amount;

        (bool success, ) = _recipient.call{value: amount}("");
        if (!success) revert RevenueSplitter__TransferFailed();

        emit ETHClaimed(_recipient, amount);
    }

    /**
     * @notice Pull-payment claim for allocated ERC20 tokens. Callable for any recipient while unpaused.
     */
    function claimERC20(address _token, address _recipient) external nonReentrant {
        emergencyPause.requireNotPaused();
        if (_token == address(0) || _recipient == address(0)) revert RevenueSplitter__ZeroAddress();

        uint256 amount = pendingERC20[_token][_recipient];
        if (amount == 0) revert RevenueSplitter__NothingToClaim();

        pendingERC20[_token][_recipient] = 0;
        totalPendingERC20[_token] -= amount;

        IERC20(_token).safeTransfer(_recipient, amount);
        emit ERC20Claimed(_token, _recipient, amount);
    }

    function _setSplits(Split[] memory _newSplits) internal {
        uint256 len = _newSplits.length;
        if (len == 0 || len > MAX_RECIPIENTS) revert RevenueSplitter__InvalidSplits();

        uint256 totalBps = 0;
        for (uint256 i = 0; i < len; i++) {
            if (_newSplits[i].recipient == address(0)) revert RevenueSplitter__ZeroAddress();
            if (_newSplits[i].bps == 0) revert RevenueSplitter__InvalidSplits();
            for (uint256 j = 0; j < i; j++) {
                if (_newSplits[j].recipient == _newSplits[i].recipient) {
                    revert RevenueSplitter__DuplicateRecipient(_newSplits[i].recipient);
                }
            }
            totalBps += _newSplits[i].bps;
        }
        if (totalBps != BPS_DENOMINATOR) revert RevenueSplitter__InvalidSplits();

        delete _splits;
        for (uint256 i = 0; i < len; i++) {
            _splits.push(_newSplits[i]);
        }

        emit SplitsUpdated(len);
    }
}