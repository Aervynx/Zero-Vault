// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../access/RoleManager.sol";
import "../security/EmergencyPause.sol";
import "./TreasuryVault.sol";

/**
 * @title Treasury
 * @author ZeroVault Lead Architect
 * @notice Main orchestration and policy-enforcement layer for ZeroVault.
 * @dev Coordinates ETH/ERC20 deposits, withdrawal request lifecycle, shared pause checks,
 *      timelock-gated execution, and controlled interaction with TreasuryVault.
 */
contract Treasury is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum RequestStatus {
        None,
        Pending,
        Executed,
        Cancelled
    }

    struct WithdrawalRequest {
        address asset; // address(0) for native ETH, token address for ERC20
        address to;
        uint256 amount;
        address requester;
        uint256 createdAt;
        RequestStatus status;
    }

    TreasuryVault public immutable vault;
    RoleManager public immutable roleManager;
    EmergencyPause public immutable emergencyPause;
    address public immutable timelock;

    uint256 public nextRequestId = 1;
    mapping(uint256 => WithdrawalRequest) public withdrawalRequests;

    event Deposited(address indexed sender, uint256 amount);
    event ERC20Deposited(address indexed token, address indexed sender, uint256 amount);
    event WithdrawalRequested(
        uint256 indexed requestId,
        address indexed asset,
        address indexed to,
        uint256 amount,
        address requester,
        string reason
    );
    event WithdrawalExecuted(
        uint256 indexed requestId,
        address indexed asset,
        address indexed to,
        uint256 amount
    );
    event WithdrawalCancelled(uint256 indexed requestId, address indexed cancelledBy);
    event Withdrawn(address indexed target, uint256 amount);
    event ERC20Withdrawn(address indexed token, address indexed target, uint256 amount);

    error Treasury__Unauthorized();
    error Treasury__InvalidTimelock();
    error Treasury__ZeroDeposit();
    error Treasury__ZeroAmount();
    error Treasury__ZeroAddress();
    error Treasury__InsufficientBalance();
    error Treasury__TransferFailed();
    error Treasury__FeeOnTransferNotSupported();
    error Treasury__RequestNotFound();
    error Treasury__InvalidRequestState(RequestStatus currentState);

    modifier onlyTimelock() {
        if (msg.sender != timelock) revert Treasury__Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        emergencyPause.requireNotPaused();
        _;
    }

    constructor(
        address _vault,
        address _roleManager,
        address _emergencyPause,
        address _timelock
    ) {
        if (_vault == address(0) || _roleManager == address(0) || _emergencyPause == address(0)) {
            revert Treasury__ZeroAddress();
        }
        if (_timelock == address(0)) revert Treasury__InvalidTimelock();

        vault = TreasuryVault(payable(_vault));
        roleManager = RoleManager(_roleManager);
        emergencyPause = EmergencyPause(_emergencyPause);
        timelock = _timelock;
    }

    function paused() external view returns (bool) {
        return emergencyPause.paused();
    }

    /**
     * @notice Explicit ETH deposit entry point. Forwards funds directly to TreasuryVault.
     */
    function deposit() external payable nonReentrant {
        if (msg.value == 0) revert Treasury__ZeroDeposit();
        (bool success, ) = payable(address(vault)).call{value: msg.value}("");
        if (!success) revert Treasury__TransferFailed();
        emit Deposited(msg.sender, msg.value);
    }

    /**
     * @notice Permissionless ERC20 deposit into TreasuryVault. Rejects fee-on-transfer tokens.
     */
    function depositERC20(address _token, uint256 _amount) external nonReentrant {
        if (_token == address(0)) revert Treasury__ZeroAddress();
        if (_amount == 0) revert Treasury__ZeroDeposit();

        uint256 balanceBefore = IERC20(_token).balanceOf(address(vault));
        IERC20(_token).safeTransferFrom(msg.sender, address(vault), _amount);
        uint256 received = IERC20(_token).balanceOf(address(vault)) - balanceBefore;

        if (received != _amount) revert Treasury__FeeOnTransferNotSupported();
        emit ERC20Deposited(_token, msg.sender, _amount);
    }

    /**
     * @notice Registers a pending ETH withdrawal request to be queued and executed via Timelock.
     */
    function requestETHWithdrawal(
        address _to,
        uint256 _amount,
        string calldata _reason
    ) external whenNotPaused returns (uint256 requestId) {
        _checkRequester(msg.sender);
        if (_to == address(0)) revert Treasury__ZeroAddress();
        if (_amount == 0) revert Treasury__ZeroAmount();
        if (vault.getBalance() < _amount) revert Treasury__InsufficientBalance();

        requestId = _registerRequest(address(0), _to, _amount, _reason);
    }

    /**
     * @notice Registers a pending ERC20 withdrawal request to be queued and executed via Timelock.
     */
    function requestERC20Withdrawal(
        address _token,
        address _to,
        uint256 _amount,
        string calldata _reason
    ) external whenNotPaused returns (uint256 requestId) {
        _checkRequester(msg.sender);
        if (_token == address(0) || _to == address(0)) revert Treasury__ZeroAddress();
        if (_amount == 0) revert Treasury__ZeroAmount();
        if (vault.getERC20Balance(_token) < _amount) revert Treasury__InsufficientBalance();

        requestId = _registerRequest(_token, _to, _amount, _reason);
    }

    /**
     * @notice Cancels a pending withdrawal request. Callable by GUARDIAN_ROLE or DEFAULT_ADMIN_ROLE even while paused.
     */
    function cancelWithdrawalRequest(uint256 _requestId) external {
        if (!roleManager.isGuardian(msg.sender) && !roleManager.isAdmin(msg.sender)) {
            revert Treasury__Unauthorized();
        }

        WithdrawalRequest storage req = withdrawalRequests[_requestId];
        if (req.status == RequestStatus.None) revert Treasury__RequestNotFound();
        if (req.status != RequestStatus.Pending) revert Treasury__InvalidRequestState(req.status);

        req.status = RequestStatus.Cancelled;
        emit WithdrawalCancelled(_requestId, msg.sender);
    }

    /**
     * @notice Executes a previously registered withdrawal request. Callable strictly by Timelock while unpaused.
     */
    function executeWithdrawal(uint256 _requestId) external onlyTimelock whenNotPaused nonReentrant {
        WithdrawalRequest storage req = withdrawalRequests[_requestId];
        if (req.status == RequestStatus.None) revert Treasury__RequestNotFound();
        if (req.status != RequestStatus.Pending) revert Treasury__InvalidRequestState(req.status);

        // Checks-Effects-Interactions: mark executed before external vault transfer
        req.status = RequestStatus.Executed;

        if (req.asset == address(0)) {
            vault.transferETH(payable(req.to), req.amount);
            emit Withdrawn(req.to, req.amount);
        } else {
            vault.transferERC20(req.asset, req.to, req.amount);
            emit ERC20Withdrawn(req.asset, req.to, req.amount);
        }

        emit WithdrawalExecuted(_requestId, req.asset, req.to, req.amount);
    }

    /**
     * @notice Direct Timelock-gated ETH withdrawal (also used by Governance TimelockController).
     */
    function withdraw(
        address payable _to,
        uint256 _amount
    ) external onlyTimelock whenNotPaused nonReentrant {
        if (_to == address(0)) revert Treasury__ZeroAddress();
        if (_amount == 0) revert Treasury__ZeroAmount();
        vault.transferETH(_to, _amount);
        emit Withdrawn(_to, _amount);
    }

    /**
     * @notice Direct Timelock-gated ERC20 withdrawal (also used by Governance TimelockController).
     */
    function withdrawERC20(
        address _token,
        address _to,
        uint256 _amount
    ) external onlyTimelock whenNotPaused nonReentrant {
        if (_token == address(0) || _to == address(0)) revert Treasury__ZeroAddress();
        if (_amount == 0) revert Treasury__ZeroAmount();
        vault.transferERC20(_token, _to, _amount);
        emit ERC20Withdrawn(_token, _to, _amount);
    }

    /**
     * @notice Accepts direct ETH transfers and forwards them to TreasuryVault.
     */
    receive() external payable nonReentrant {
        if (msg.value > 0) {
            (bool success, ) = payable(address(vault)).call{value: msg.value}("");
            if (!success) revert Treasury__TransferFailed();
            emit Deposited(msg.sender, msg.value);
        }
    }

    function _checkRequester(address account) internal view {
        if (
            !roleManager.isOperator(account) &&
            !roleManager.isBudgetManager(account) &&
            !roleManager.isAdmin(account)
        ) {
            revert Treasury__Unauthorized();
        }
    }

    function _registerRequest(
        address _asset,
        address _to,
        uint256 _amount,
        string calldata _reason
    ) internal returns (uint256 requestId) {
        requestId = nextRequestId++;
        withdrawalRequests[requestId] = WithdrawalRequest({
            asset: _asset,
            to: _to,
            amount: _amount,
            requester: msg.sender,
            createdAt: block.timestamp,
            status: RequestStatus.Pending
        });

        emit WithdrawalRequested(requestId, _asset, _to, _amount, msg.sender, _reason);
    }
}