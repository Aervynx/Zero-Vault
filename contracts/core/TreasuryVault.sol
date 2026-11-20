// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../access/RoleManager.sol";
import "../security/EmergencyPause.sol";

/**
 * @title TreasuryVault
 * @author ZeroVault Lead Architect
 * @notice Custody-only vault for ETH and ERC20 assets with one-time controller initialization,
 *         reentrancy protection, shared pause enforcement, and explicit token compatibility checks.
 */
contract TreasuryVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    RoleManager public immutable roleManager;
    EmergencyPause public immutable emergencyPause;

    address public controller;
    bool public controllerInitialized;

    event ControllerInitialized(address indexed controller);
    event FundsDeposited(address indexed sender, uint256 amount);
    event ERC20FundsDeposited(address indexed token, address indexed sender, uint256 amount);
    event FundsWithdrawn(address indexed target, uint256 amount);
    event ERC20FundsWithdrawn(address indexed token, address indexed target, uint256 amount);

    error TreasuryVault__ZeroAddress();
    error TreasuryVault__ZeroAmount();
    error TreasuryVault__Unauthorized();
    error TreasuryVault__ControllerAlreadySet();
    error TreasuryVault__ControllerNotSet();
    error TreasuryVault__InsufficientBalance();
    error TreasuryVault__TransferFailed();
    error TreasuryVault__FeeOnTransferNotSupported();

    modifier onlyController() {
        if (!controllerInitialized) revert TreasuryVault__ControllerNotSet();
        if (msg.sender != controller) revert TreasuryVault__Unauthorized();
        _;
    }

    constructor(address _roleManager, address _emergencyPause) {
        if (_roleManager == address(0) || _emergencyPause == address(0)) {
            revert TreasuryVault__ZeroAddress();
        }
        roleManager = RoleManager(_roleManager);
        emergencyPause = EmergencyPause(_emergencyPause);
    }

    /**
     * @notice Permanently binds the vault to its Treasury controller (one-time setup).
     * @dev Eliminates circular deployment dependency without fragile nonce prediction.
     */
    function initializeController(address _controller) external {
        if (!roleManager.isAdmin(msg.sender)) revert TreasuryVault__Unauthorized();
        if (controllerInitialized) revert TreasuryVault__ControllerAlreadySet();
        if (_controller == address(0)) revert TreasuryVault__ZeroAddress();

        controller = _controller;
        controllerInitialized = true;
        emit ControllerInitialized(_controller);
    }

    /**
     * @notice Accepts direct ETH deposits.
     */
    receive() external payable {
        if (msg.value > 0) {
            emit FundsDeposited(msg.sender, msg.value);
        }
    }

    /**
     * @notice Explicit ETH deposit entry point.
     */
    function depositETH() external payable {
        if (msg.value == 0) revert TreasuryVault__ZeroAmount();
        emit FundsDeposited(msg.sender, msg.value);
    }

    /**
     * @notice Permissionless ERC20 deposit into the pooled treasury vault.
     * @dev Explicitly rejects fee-on-transfer tokens by verifying exact balance delta.
     */
    function depositERC20(address _token, uint256 _amount) external nonReentrant {
        if (_token == address(0)) revert TreasuryVault__ZeroAddress();
        if (_amount == 0) revert TreasuryVault__ZeroAmount();

        uint256 balanceBefore = IERC20(_token).balanceOf(address(this));
        IERC20(_token).safeTransferFrom(msg.sender, address(this), _amount);
        uint256 received = IERC20(_token).balanceOf(address(this)) - balanceBefore;

        if (received != _amount) revert TreasuryVault__FeeOnTransferNotSupported();

        emit ERC20FundsDeposited(_token, msg.sender, _amount);
    }

    /**
     * @notice Transfers ETH out of the vault. Callable strictly by Treasury while unpaused.
     */
    function transferETH(address payable _to, uint256 _amount) external onlyController nonReentrant {
        emergencyPause.requireNotPaused();
        if (_to == address(0)) revert TreasuryVault__ZeroAddress();
        if (_amount == 0) revert TreasuryVault__ZeroAmount();
        if (address(this).balance < _amount) revert TreasuryVault__InsufficientBalance();

        (bool success, ) = _to.call{value: _amount}("");
        if (!success) revert TreasuryVault__TransferFailed();

        emit FundsWithdrawn(_to, _amount);
    }

    /**
     * @notice Transfers ERC20 tokens out of the vault. Callable strictly by Treasury while unpaused.
     */
    function transferERC20(
        address _token,
        address _to,
        uint256 _amount
    ) external onlyController nonReentrant {
        emergencyPause.requireNotPaused();
        if (_token == address(0) || _to == address(0)) revert TreasuryVault__ZeroAddress();
        if (_amount == 0) revert TreasuryVault__ZeroAmount();
        if (IERC20(_token).balanceOf(address(this)) < _amount) {
            revert TreasuryVault__InsufficientBalance();
        }

        IERC20(_token).safeTransfer(_to, _amount);
        emit ERC20FundsWithdrawn(_token, _to, _amount);
    }

    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }

    function getERC20Balance(address _token) external view returns (uint256) {
        if (_token == address(0)) revert TreasuryVault__ZeroAddress();
        return IERC20(_token).balanceOf(address(this));
    }
}