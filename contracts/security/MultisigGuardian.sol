// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./EmergencyPause.sol";

/**
 * @title MultiSigGuardian
 * @author ZeroVault Lead Architect
 * @notice M-of-N multi-signature governance/recovery controller for critical ZeroVault actions
 *         (unpause, role administration, asset unfreeze) with fast 1-of-N emergency pause defense.
 */
contract MultiSigGuardian is ReentrancyGuard {
    struct Action {
        address target;
        uint256 value;
        bytes data;
        uint256 confirmations;
        bool executed;
    }

    EmergencyPause public immutable emergencyPause;

    address[] public signers;
    mapping(address => bool) public isSigner;
    uint256 public threshold;

    uint256 public nextActionId = 1;
    mapping(uint256 => Action) public actions;
    mapping(uint256 => mapping(address => bool)) public confirmedBy;

    event ActionProposed(
        uint256 indexed actionId,
        address indexed proposer,
        address indexed target,
        uint256 value,
        bytes data,
        string description
    );
    event ActionConfirmed(uint256 indexed actionId, address indexed signer, uint256 confirmations);
    event ConfirmationRevoked(uint256 indexed actionId, address indexed signer, uint256 confirmations);
    event ActionExecuted(uint256 indexed actionId, address indexed executor);
    event FastEmergencyPauseTriggered(address indexed signer);
    event SignerAdded(address indexed signer);
    event SignerRemoved(address indexed signer);
    event ThresholdChanged(uint256 oldThreshold, uint256 newThreshold);

    error MultiSigGuardian__ZeroAddress();
    error MultiSigGuardian__InvalidThreshold();
    error MultiSigGuardian__DuplicateSigner(address signer);
    error MultiSigGuardian__NotSigner();
    error MultiSigGuardian__OnlySelf();
    error MultiSigGuardian__ActionNotFound();
    error MultiSigGuardian__AlreadyConfirmed();
    error MultiSigGuardian__NotConfirmed();
    error MultiSigGuardian__AlreadyExecuted();
    error MultiSigGuardian__InsufficientConfirmations(uint256 current, uint256 required);
    error MultiSigGuardian__ExecutionFailed();
    error MultiSigGuardian__SignerNotFound();

    modifier onlySigner() {
        if (!isSigner[msg.sender]) revert MultiSigGuardian__NotSigner();
        _;
    }

    modifier onlySelf() {
        if (msg.sender != address(this)) revert MultiSigGuardian__OnlySelf();
        _;
    }

    constructor(address _emergencyPause, address[] memory _signers, uint256 _threshold) {
        if (_emergencyPause == address(0)) revert MultiSigGuardian__ZeroAddress();
        if (_threshold == 0 || _threshold > _signers.length) {
            revert MultiSigGuardian__InvalidThreshold();
        }

        emergencyPause = EmergencyPause(_emergencyPause);

        for (uint256 i = 0; i < _signers.length; i++) {
            address s = _signers[i];
            if (s == address(0)) revert MultiSigGuardian__ZeroAddress();
            if (isSigner[s]) revert MultiSigGuardian__DuplicateSigner(s);
            isSigner[s] = true;
            signers.push(s);
        }

        threshold = _threshold;
    }

    function getSigners() external view returns (address[] memory) {
        return signers;
    }

    /**
     * @notice Fast-path 1-of-N emergency defense: any signer can trigger protocol pause immediately.
     * @dev Requires MultiSigGuardian to hold GUARDIAN_ROLE or DEFAULT_ADMIN_ROLE on RoleManager.
     */
    function triggerEmergencyPause() external onlySigner nonReentrant {
        emergencyPause.pause();
        emit FastEmergencyPauseTriggered(msg.sender);
    }

    /**
     * @notice Proposes a critical action (e.g., unpause, grantRole, unfreezeAsset) and auto-confirms for proposer.
     */
    function proposeAction(
        address target,
        uint256 value,
        bytes calldata data,
        string calldata description
    ) external onlySigner returns (uint256 actionId) {
        if (target == address(0)) revert MultiSigGuardian__ZeroAddress();

        actionId = nextActionId++;
        actions[actionId] = Action({
            target: target,
            value: value,
            data: data,
            confirmations: 1,
            executed: false
        });
        confirmedBy[actionId][msg.sender] = true;

        emit ActionProposed(actionId, msg.sender, target, value, data, description);
        emit ActionConfirmed(actionId, msg.sender, 1);
    }

    /**
     * @notice Confirms a pending action.
     */
    function confirmAction(uint256 actionId) external onlySigner {
        Action storage a = actions[actionId];
        if (a.target == address(0)) revert MultiSigGuardian__ActionNotFound();
        if (a.executed) revert MultiSigGuardian__AlreadyExecuted();
        if (confirmedBy[actionId][msg.sender]) revert MultiSigGuardian__AlreadyConfirmed();

        confirmedBy[actionId][msg.sender] = true;
        a.confirmations += 1;

        emit ActionConfirmed(actionId, msg.sender, a.confirmations);
    }

    /**
     * @notice Revokes a previously submitted confirmation before execution.
     */
    function revokeConfirmation(uint256 actionId) external onlySigner {
        Action storage a = actions[actionId];
        if (a.target == address(0)) revert MultiSigGuardian__ActionNotFound();
        if (a.executed) revert MultiSigGuardian__AlreadyExecuted();
        if (!confirmedBy[actionId][msg.sender]) revert MultiSigGuardian__NotConfirmed();

        confirmedBy[actionId][msg.sender] = false;
        a.confirmations -= 1;

        emit ConfirmationRevoked(actionId, msg.sender, a.confirmations);
    }

    /**
     * @notice Executes an action once M-of-N confirmations have been reached.
     */
    function executeAction(uint256 actionId) external onlySigner nonReentrant returns (bytes memory) {
        Action storage a = actions[actionId];
        if (a.target == address(0)) revert MultiSigGuardian__ActionNotFound();
        if (a.executed) revert MultiSigGuardian__AlreadyExecuted();
        if (a.confirmations < threshold) {
            revert MultiSigGuardian__InsufficientConfirmations(a.confirmations, threshold);
        }

        // CEI: mark executed before external call
        a.executed = true;

        (bool success, bytes memory result) = a.target.call{value: a.value}(a.data);
        if (!success) revert MultiSigGuardian__ExecutionFailed();

        emit ActionExecuted(actionId, msg.sender);
        return result;
    }

    function addSigner(address newSigner) external onlySelf {
        if (newSigner == address(0)) revert MultiSigGuardian__ZeroAddress();
        if (isSigner[newSigner]) revert MultiSigGuardian__DuplicateSigner(newSigner);

        isSigner[newSigner] = true;
        signers.push(newSigner);
        emit SignerAdded(newSigner);
    }

    function removeSigner(address signerToRemove) external onlySelf {
        if (!isSigner[signerToRemove]) revert MultiSigGuardian__SignerNotFound();
        if (signers.length - 1 < threshold) revert MultiSigGuardian__InvalidThreshold();

        isSigner[signerToRemove] = false;
        for (uint256 i = 0; i < signers.length; i++) {
            if (signers[i] == signerToRemove) {
                signers[i] = signers[signers.length - 1];
                signers.pop();
                break;
            }
        }

        emit SignerRemoved(signerToRemove);
    }

    function changeThreshold(uint256 newThreshold) external onlySelf {
        if (newThreshold == 0 || newThreshold > signers.length) {
            revert MultiSigGuardian__InvalidThreshold();
        }
        uint256 oldThreshold = threshold;
        threshold = newThreshold;
        emit ThresholdChanged(oldThreshold, newThreshold);
    }

    receive() external payable {}
}