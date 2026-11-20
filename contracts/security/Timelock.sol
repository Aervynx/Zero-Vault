// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../access/RoleManager.sol";
import "./EmergencyPause.sol";

/**
 * @title Timelock
 * @author ZeroVault Lead Architect
 * @notice Security-first delayed execution controller with explicit operation state machine,
 *         target allowlist, role separation, and shared emergency pause enforcement.
 */
contract Timelock is ReentrancyGuard {
    enum OperationState {
        None,
        Queued,
        Ready,
        Executed,
        Cancelled,
        Expired
    }

    struct Operation {
        address target;
        uint256 value;
        bytes32 dataHash;
        uint256 queuedAt;
        uint256 eta;
        bool executed;
        bool cancelled;
    }

    RoleManager public immutable roleManager;
    EmergencyPause public immutable emergencyPause;

    uint256 public constant MIN_DELAY = 1 days;
    uint256 public constant MAX_DELAY = 30 days;
    uint256 public constant GRACE_PERIOD = 14 days;

    uint256 public delay;
    bool public initialTargetSet;

    mapping(bytes32 => Operation) public operations;
    mapping(address => bool) public allowedTargets;

    event OperationQueued(
        bytes32 indexed opId,
        address indexed target,
        uint256 value,
        string signature,
        bytes data,
        uint256 eta,
        bytes32 salt,
        address indexed queuedBy
    );
    event OperationExecuted(
        bytes32 indexed opId,
        address indexed target,
        uint256 value,
        uint256 eta,
        bytes32 salt,
        address indexed executedBy
    );
    event OperationCancelled(bytes32 indexed opId, address indexed cancelledBy);
    event NewDelay(uint256 oldDelay, uint256 indexed newDelay);
    event TargetAllowanceUpdated(address indexed target, bool allowed);

    error Timelock__ZeroAddress();
    error Timelock__Unauthorized();
    error Timelock__InvalidDelay();
    error Timelock__TargetNotAllowed(address target);
    error Timelock__InitialTargetAlreadySet();
    error Timelock__TxNotFound();
    error Timelock__TxAlreadyQueued();
    error Timelock__TxNotReady();
    error Timelock__TxExpired();
    error Timelock__InvalidState(OperationState currentState);
    error Timelock__TxExecutionFailed();

    constructor(address _roleManager, address _emergencyPause, uint256 _delay) {
        if (_roleManager == address(0) || _emergencyPause == address(0)) {
            revert Timelock__ZeroAddress();
        }
        if (_delay < MIN_DELAY || _delay > MAX_DELAY) revert Timelock__InvalidDelay();

        roleManager = RoleManager(_roleManager);
        emergencyPause = EmergencyPause(_emergencyPause);
        delay = _delay;

        // Allow self-calls so delay and target updates must go through Timelock itself
        allowedTargets[address(this)] = true;
        emit TargetAllowanceUpdated(address(this), true);
    }

    /**
     * @notice One-time deployment helper to register the primary Treasury target.
     * @dev Further target changes must go through Timelock itself via `setTargetAllowed`.
     */
    function initializeTarget(address target) external {
        if (!roleManager.isAdmin(msg.sender)) revert Timelock__Unauthorized();
        if (initialTargetSet) revert Timelock__InitialTargetAlreadySet();
        if (target == address(0)) revert Timelock__ZeroAddress();

        initialTargetSet = true;
        allowedTargets[target] = true;
        emit TargetAllowanceUpdated(target, true);
    }

    /**
     * @notice Updates whether a target contract can be called by this Timelock.
     * @dev Can only be executed by the Timelock itself after waiting the full delay.
     */
    function setTargetAllowed(address target, bool allowed) external {
        if (msg.sender != address(this)) revert Timelock__Unauthorized();
        if (target == address(0)) revert Timelock__ZeroAddress();

        allowedTargets[target] = allowed;
        emit TargetAllowanceUpdated(target, allowed);
    }

    /**
     * @notice Updates the minimum execution delay for future operations.
     * @dev Can only be executed by the Timelock itself. Does not alter already-queued operations.
     */
    function setDelay(uint256 _delay) external {
        if (msg.sender != address(this)) revert Timelock__Unauthorized();
        if (_delay < MIN_DELAY || _delay > MAX_DELAY) revert Timelock__InvalidDelay();

        uint256 oldDelay = delay;
        delay = _delay;
        emit NewDelay(oldDelay, _delay);
    }

    /**
     * @notice Computes the collision-resistant operation ID using abi.encode.
     */
    function computeOperationId(
        address target,
        uint256 value,
        string calldata signature,
        bytes calldata data,
        uint256 eta,
        bytes32 salt
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(target, value, signature, data, eta, salt));
    }

    /**
     * @notice Returns the current lifecycle state of an operation.
     */
    function getOperationState(bytes32 opId) public view returns (OperationState) {
        Operation storage op = operations[opId];
        if (op.queuedAt == 0) return OperationState.None;
        if (op.executed) return OperationState.Executed;
        if (op.cancelled) return OperationState.Cancelled;
        if (block.timestamp > op.eta + GRACE_PERIOD) return OperationState.Expired;
        if (block.timestamp >= op.eta) return OperationState.Ready;
        return OperationState.Queued;
    }

    /**
     * @notice Queues a sensitive operation for delayed execution.
     * @dev Callable by OPERATOR_ROLE or DEFAULT_ADMIN_ROLE while not paused.
     */
    function queueTransaction(
        address target,
        uint256 value,
        string calldata signature,
        bytes calldata data,
        uint256 eta,
        bytes32 salt
    ) external returns (bytes32 opId) {
        if (!roleManager.isOperator(msg.sender) && !roleManager.isAdmin(msg.sender)) {
            revert Timelock__Unauthorized();
        }
        emergencyPause.requireNotPaused();

      if (target == address(0)) revert Timelock__ZeroAddress();
        if (!allowedTargets[target]) revert Timelock__TargetNotAllowed(target);

        opId = computeOperationId(target, value, signature, data, eta, salt);
        if (operations[opId].queuedAt != 0) revert Timelock__TxAlreadyQueued();
        if (eta < block.timestamp + delay) revert Timelock__InvalidDelay();
        
        operations[opId] = Operation({
            target: target,
            value: value,
            dataHash: keccak256(_buildCallData(signature, data)),
            queuedAt: block.timestamp,
            eta: eta,
            executed: false,
            cancelled: false
        });

        emit OperationQueued(opId, target, value, signature, data, eta, salt, msg.sender);
    }

    /**
     * @notice Cancels a queued or ready operation.
     * @dev Callable by GUARDIAN_ROLE or DEFAULT_ADMIN_ROLE even while the protocol is paused.
     */
    function cancelTransaction(bytes32 opId) external {
        if (!roleManager.isGuardian(msg.sender) && !roleManager.isAdmin(msg.sender)) {
            revert Timelock__Unauthorized();
        }

        OperationState state = getOperationState(opId);
        if (state == OperationState.None) revert Timelock__TxNotFound();
        if (state != OperationState.Queued && state != OperationState.Ready) {
            revert Timelock__InvalidState(state);
        }

        operations[opId].cancelled = true;
        emit OperationCancelled(opId, msg.sender);
    }

    /**
     * @notice Executes a ready operation after its waiting period has elapsed.
     * @dev Callable by EXECUTOR_ROLE or DEFAULT_ADMIN_ROLE while not paused. Protected against reentrancy.
     */
    function executeTransaction(
        address target,
        uint256 value,
        string calldata signature,
        bytes calldata data,
        uint256 eta,
        bytes32 salt
    ) external payable nonReentrant returns (bytes memory) {
        if (!roleManager.isExecutor(msg.sender) && !roleManager.isAdmin(msg.sender)) {
            revert Timelock__Unauthorized();
        }
        emergencyPause.requireNotPaused();

        if (!allowedTargets[target]) revert Timelock__TargetNotAllowed(target);

        bytes32 opId = computeOperationId(target, value, signature, data, eta, salt);
        _validateExecutable(opId);

        // Checks-Effects-Interactions: mark executed before external call
        operations[opId].executed = true;

        (bool success, bytes memory result) = target.call{value: value}(
            _buildCallData(signature, data)
        );
        if (!success) revert Timelock__TxExecutionFailed();

        emit OperationExecuted(opId, target, value, eta, salt, msg.sender);
        return result;
    }

    function _validateExecutable(bytes32 opId) internal view {
        OperationState state = getOperationState(opId);
        if (state == OperationState.None) revert Timelock__TxNotFound();
        if (state == OperationState.Queued) revert Timelock__TxNotReady();
        if (state == OperationState.Expired) revert Timelock__TxExpired();
        if (state != OperationState.Ready) revert Timelock__InvalidState(state);
    }

    function _buildCallData(
        string calldata signature,
        bytes calldata data
    ) internal pure returns (bytes memory) {
        if (bytes(signature).length == 0) {
            return data;
        }
        return abi.encodePacked(bytes4(keccak256(bytes(signature))), data);
    }

    receive() external payable {}
}