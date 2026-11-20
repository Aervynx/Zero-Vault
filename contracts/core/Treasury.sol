// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../access/RoleManager.sol";
import "../security/EmergencyPause.sol";
import "../security/AssetRegistry.sol";
import "../security/BudgetController.sol";
import "./TreasuryVault.sol";

/**
 * @title Treasury
 * @author ZeroVault Lead Architect
 * @notice Main orchestration and policy-enforcement layer for ZeroVault multi-asset custody.
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
        address asset; // address(0) for native ETH, token address for ERC20/RWA
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

    BudgetController public budgetController;

    uint256 public nextRequestId = 1;
    mapping(uint256 => WithdrawalRequest) public withdrawalRequests;

    event BudgetControllerUpdated(address indexed budgetController);
    event Deposited(address indexed sender, uint256 amount);
    event ERC20Deposited(address indexed token, address indexed sender, uint256 amount);
    event ERC721Deposited(address indexed token, address indexed sender, uint256 indexed tokenId);
    event ERC1155Deposited(address indexed token, address indexed sender, uint256 indexed id, uint256 amount);
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
    event ERC721Withdrawn(address indexed token, address indexed target, uint256 indexed tokenId);
    event ERC1155Withdrawn(address indexed token, address indexed target, uint256 indexed id, uint256 amount);

    event ERC4907UserSet(
        address indexed token,
        uint256 indexed tokenId,
        address indexed user,
        uint64 expires
    );
    event ERC4907UserRevoked(
        address indexed token,
        uint256 indexed tokenId,
        address indexed revokedBy
    );

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

    /**
     * @notice Attaches the BudgetController for rolling epoch spending caps. Admin only.
     */
    function setBudgetController(address _budgetController) external {
        if (!roleManager.isAdmin(msg.sender)) revert Treasury__Unauthorized();
        if (_budgetController == address(0)) revert Treasury__ZeroAddress();
        budgetController = BudgetController(_budgetController);
        emit BudgetControllerUpdated(_budgetController);
    }

    function paused() external view returns (bool) {
        return emergencyPause.paused();
    }

    function deposit() external payable nonReentrant {
        if (msg.value == 0) revert Treasury__ZeroDeposit();
        (bool success, ) = payable(address(vault)).call{value: msg.value}("");
        if (!success) revert Treasury__TransferFailed();
        emit Deposited(msg.sender, msg.value);
    }

    function depositERC20(address _token, uint256 _amount) external nonReentrant {
        if (_token == address(0)) revert Treasury__ZeroAddress();
        if (_amount == 0) revert Treasury__ZeroDeposit();

        AssetRegistry registry = vault.assetRegistry();
        if (address(registry) != address(0)) {
            registry.validateDeposit(_token, AssetRegistry.AssetType.ERC20);
        }

        uint256 balanceBefore = IERC20(_token).balanceOf(address(vault));
        IERC20(_token).safeTransferFrom(msg.sender, address(vault), _amount);
        uint256 received = IERC20(_token).balanceOf(address(vault)) - balanceBefore;

        if (received != _amount) revert Treasury__FeeOnTransferNotSupported();
        emit ERC20Deposited(_token, msg.sender, _amount);
    }

    function depositERC721(address _token, uint256 _tokenId) external nonReentrant {
        if (_token == address(0)) revert Treasury__ZeroAddress();
        IERC721(_token).safeTransferFrom(msg.sender, address(vault), _tokenId);
        emit ERC721Deposited(_token, msg.sender, _tokenId);
    }

    function depositERC1155(address _token, uint256 _id, uint256 _amount) external nonReentrant {
        if (_token == address(0)) revert Treasury__ZeroAddress();
        if (_amount == 0) revert Treasury__ZeroAmount();
        IERC1155(_token).safeTransferFrom(msg.sender, address(vault), _id, _amount, "");
        emit ERC1155Deposited(_token, msg.sender, _id, _amount);
    }

    function requestETHWithdrawal(
        address _to,
        uint256 _amount,
        string calldata _reason
    ) external whenNotPaused returns (uint256 requestId) {
        _checkRequester(msg.sender);
        if (_to == address(0)) revert Treasury__ZeroAddress();
        if (_amount == 0) revert Treasury__ZeroAmount();
        if (vault.getBalance() < _amount) revert Treasury__InsufficientBalance();
        if (address(budgetController) != address(0)) {
            budgetController.previewConsume(address(0), _amount);
        }

        requestId = _registerRequest(address(0), _to, _amount, _reason);
    }

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

        AssetRegistry registry = vault.assetRegistry();
        if (address(registry) != address(0)) {
            registry.validateWithdrawal(_token, AssetRegistry.AssetType.ERC20, _amount);
        }
        if (address(budgetController) != address(0)) {
            budgetController.previewConsume(_token, _amount);
        }

        requestId = _registerRequest(_token, _to, _amount, _reason);
    }

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

    function executeWithdrawal(uint256 _requestId) external onlyTimelock whenNotPaused nonReentrant {
        WithdrawalRequest storage req = withdrawalRequests[_requestId];
        if (req.status == RequestStatus.None) revert Treasury__RequestNotFound();
        if (req.status != RequestStatus.Pending) revert Treasury__InvalidRequestState(req.status);

        req.status = RequestStatus.Executed;
        if (address(budgetController) != address(0)) {
            budgetController.consumeBudget(req.asset, req.amount);
        }

        if (req.asset == address(0)) {
            vault.transferETH(payable(req.to), req.amount);
            emit Withdrawn(req.to, req.amount);
        } else {
            vault.transferERC20(req.asset, req.to, req.amount);
            emit ERC20Withdrawn(req.asset, req.to, req.amount);
        }

        emit WithdrawalExecuted(_requestId, req.asset, req.to, req.amount);
    }

    function withdraw(
        address payable _to,
        uint256 _amount
    ) external onlyTimelock whenNotPaused nonReentrant {
        if (_to == address(0)) revert Treasury__ZeroAddress();
        if (_amount == 0) revert Treasury__ZeroAmount();
        if (address(budgetController) != address(0)) {
            budgetController.consumeBudget(address(0), _amount);
        }
        vault.transferETH(_to, _amount);
        emit Withdrawn(_to, _amount);
    }

    function withdrawERC20(
        address _token,
        address _to,
        uint256 _amount
    ) external onlyTimelock whenNotPaused nonReentrant {
        if (_token == address(0) || _to == address(0)) revert Treasury__ZeroAddress();
        if (_amount == 0) revert Treasury__ZeroAmount();
        if (address(budgetController) != address(0)) {
            budgetController.consumeBudget(_token, _amount);
        }
        vault.transferERC20(_token, _to, _amount);
        emit ERC20Withdrawn(_token, _to, _amount);
    }

    function withdrawERC721(
        address _token,
        address _to,
        uint256 _tokenId
    ) external onlyTimelock whenNotPaused nonReentrant {
        if (_token == address(0) || _to == address(0)) revert Treasury__ZeroAddress();
        vault.transferERC721(_token, _to, _tokenId);
        emit ERC721Withdrawn(_token, _to, _tokenId);
    }

    function withdrawERC1155(
        address _token,
        address _to,
        uint256 _id,
        uint256 _amount
    ) external onlyTimelock whenNotPaused nonReentrant {
        if (_token == address(0) || _to == address(0)) revert Treasury__ZeroAddress();
        if (_amount == 0) revert Treasury__ZeroAmount();
        vault.transferERC1155(_token, _to, _id, _amount);
        emit ERC1155Withdrawn(_token, _to, _id, _amount);
    }

    /**
     * @notice Grants temporary ERC-4907 rental rights via Timelock while keeping NFT ownership in Vault.
     */
    function setERC4907User(
        address _token,
        uint256 _tokenId,
        address _user,
        uint64 _expires
    ) external onlyTimelock whenNotPaused nonReentrant {
        if (_token == address(0) || _user == address(0)) revert Treasury__ZeroAddress();
        vault.setERC4907User(_token, _tokenId, _user, _expires);
        emit ERC4907UserSet(_token, _tokenId, _user, _expires);
    }

    /**
     * @notice Emergency revocation of an active ERC-4907 renter. Callable by GUARDIAN_ROLE or DEFAULT_ADMIN_ROLE even while paused.
     */
    function revokeERC4907User(address _token, uint256 _tokenId) external nonReentrant {
        if (!roleManager.isGuardian(msg.sender) && !roleManager.isAdmin(msg.sender)) {
            revert Treasury__Unauthorized();
        }
        if (_token == address(0)) revert Treasury__ZeroAddress();

        vault.setERC4907User(_token, _tokenId, address(0), 0);
        emit ERC4907UserRevoked(_token, _tokenId, msg.sender);
    }


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