// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "../access/RoleManager.sol";

contract Timelock {
    RoleManager public immutable roleManager;
    uint256 public constant MIN_DELAY = 1 days;
    uint256 public constant MAX_DELAY = 30 days;
    uint256 public delay;

    event QueueTransaction(bytes32 indexed txHash, address indexed target, uint256 value, string signature, bytes data, uint256 eta);
    event ExecuteTransaction(bytes32 indexed txHash, address indexed target, uint256 value, string signature, bytes data, uint256 eta);
    event CancelTransaction(bytes32 indexed txHash, address indexed target, uint256 value, string signature, bytes data, uint256 eta);
    event NewDelay(uint256 indexed newDelay);

    error Timelock__Unauthorized();
    error Timelock__InvalidDelay();
    error Timelock__TxNotFound();
    error Timelock__TxNotReady();
    error Timelock__TxAlreadyQueued();
    error Timelock__TxExecutionFailed();

    mapping(bytes32 => bool) public queuedTransactions;

    constructor(address _roleManager, uint256 _delay) {
        roleManager = RoleManager(_roleManager);
        if (_delay < MIN_DELAY || _delay > MAX_DELAY) revert Timelock__InvalidDelay();
        delay = _delay;
    }

    function setDelay(uint256 _delay) external {
        if (msg.sender != address(this)) revert Timelock__Unauthorized();
        if (_delay < MIN_DELAY || _delay > MAX_DELAY) revert Timelock__InvalidDelay();
        delay = _delay;
        emit NewDelay(_delay);
    }

    function queueTransaction(
        address target,
        uint256 value,
        string memory signature,
        bytes memory data,
        uint256 eta
    ) external returns (bytes32) {
        if (!roleManager.hasRole(roleManager.DEFAULT_ADMIN_ROLE(), msg.sender)) {
            revert Timelock__Unauthorized();
        }
        if (eta < block.timestamp + delay) revert Timelock__InvalidDelay();

        bytes32 txHash = keccak256(abi.encodePacked(target, value, signature, data, eta));
        if (queuedTransactions[txHash]) revert Timelock__TxAlreadyQueued();

        queuedTransactions[txHash] = true;
        emit QueueTransaction(txHash, target, value, signature, data, eta);
        return txHash;
    }

    function cancelTransaction(
        address target,
        uint256 value,
        string memory signature,
        bytes memory data,
        uint256 eta
    ) external {
        if (!roleManager.hasRole(roleManager.DEFAULT_ADMIN_ROLE(), msg.sender)) {
            revert Timelock__Unauthorized();
        }

        bytes32 txHash = keccak256(abi.encodePacked(target, value, signature, data, eta));
        if (!queuedTransactions[txHash]) revert Timelock__TxNotFound();

        queuedTransactions[txHash] = false;
        emit CancelTransaction(txHash, target, value, signature, data, eta);
    }

    function executeTransaction(
        address target,
        uint256 value,
        string memory signature,
        bytes memory data,
        uint256 eta
    ) external payable returns (bytes memory) {
        if (!roleManager.hasRole(roleManager.DEFAULT_ADMIN_ROLE(), msg.sender)) {
            revert Timelock__Unauthorized();
        }

        bytes32 txHash = keccak256(abi.encodePacked(target, value, signature, data, eta));
        if (!queuedTransactions[txHash]) revert Timelock__TxNotFound();
        if (block.timestamp < eta) revert Timelock__TxNotReady();
        if (block.timestamp > eta + 14 days) revert Timelock__TxNotReady(); // Grace period

        queuedTransactions[txHash] = false;

        bytes memory callData;
        if (bytes(signature).length == 0) {
            callData = data;
        } else {
            callData = abi.encodePacked(bytes4(keccak256(bytes(signature))), data);
        }

        (bool success, bytes memory returnData) = target.call{value: value}(callData);
        if (!success) revert Timelock__TxExecutionFailed();

        emit ExecuteTransaction(txHash, target, value, signature, data, eta);
        return returnData;
    }

    receive() external payable {}
}