// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../access/RoleManager.sol";
import "../security/EmergencyPause.sol";
import "../security/AssetRegistry.sol";

/**
 * @title TreasuryVault
 * @author ZeroVault Lead Architect
 * @notice Multi-asset custody vault supporting ETH, ERC20, RWA (ERC20), ERC721, Hierarchical NFTs, and ERC1155.
 * @dev Enforces one-time controller binding, shared EmergencyPause, ReentrancyGuard, and optional AssetRegistry vetting.
 */
contract TreasuryVault is ReentrancyGuard, ERC721Holder, ERC1155Holder {
    using SafeERC20 for IERC20;

    RoleManager public immutable roleManager;
    EmergencyPause public immutable emergencyPause;

    address public controller;
    bool public controllerInitialized;
    AssetRegistry public assetRegistry;

    event ControllerInitialized(address indexed controller);
    event AssetRegistryUpdated(address indexed registry);
    event FundsDeposited(address indexed sender, uint256 amount);
    event ERC20FundsDeposited(address indexed token, address indexed sender, uint256 amount);
    event ERC721Deposited(address indexed token, address indexed sender, uint256 indexed tokenId);
    event ERC1155Deposited(address indexed token, address indexed sender, uint256 indexed id, uint256 amount);
    event FundsWithdrawn(address indexed target, uint256 amount);
    event ERC20FundsWithdrawn(address indexed token, address indexed target, uint256 amount);
    event ERC721Withdrawn(address indexed token, address indexed target, uint256 indexed tokenId);
    event ERC1155Withdrawn(address indexed token, address indexed target, uint256 indexed id, uint256 amount);

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
     * @notice Attaches or updates the AssetRegistry gatekeeper. Callable strictly by DEFAULT_ADMIN_ROLE.
     */
    function setAssetRegistry(address _registry) external {
        if (!roleManager.isAdmin(msg.sender)) revert TreasuryVault__Unauthorized();
        if (_registry == address(0)) revert TreasuryVault__ZeroAddress();
        assetRegistry = AssetRegistry(_registry);
        emit AssetRegistryUpdated(_registry);
    }

    receive() external payable {
        if (msg.value > 0) {
            emit FundsDeposited(msg.sender, msg.value);
        }
    }

    function depositETH() external payable {
        if (msg.value == 0) revert TreasuryVault__ZeroAmount();
        emit FundsDeposited(msg.sender, msg.value);
    }

    function depositERC20(address _token, uint256 _amount) external nonReentrant {
        if (_token == address(0)) revert TreasuryVault__ZeroAddress();
        if (_amount == 0) revert TreasuryVault__ZeroAmount();
        if (address(assetRegistry) != address(0)) {
            assetRegistry.validateDeposit(_token, AssetRegistry.AssetType.ERC20);
        }

        uint256 balanceBefore = IERC20(_token).balanceOf(address(this));
        IERC20(_token).safeTransferFrom(msg.sender, address(this), _amount);
        uint256 received = IERC20(_token).balanceOf(address(this)) - balanceBefore;

        if (received != _amount) revert TreasuryVault__FeeOnTransferNotSupported();
        emit ERC20FundsDeposited(_token, msg.sender, _amount);
    }

    function depositERC721(address _token, uint256 _tokenId) external nonReentrant {
        if (_token == address(0)) revert TreasuryVault__ZeroAddress();
        if (address(assetRegistry) != address(0)) {
            assetRegistry.validateDeposit(_token, AssetRegistry.AssetType.ERC721);
        }

        IERC721(_token).safeTransferFrom(msg.sender, address(this), _tokenId);
        emit ERC721Deposited(_token, msg.sender, _tokenId);
    }

    function depositERC1155(address _token, uint256 _id, uint256 _amount) external nonReentrant {
        if (_token == address(0)) revert TreasuryVault__ZeroAddress();
        if (_amount == 0) revert TreasuryVault__ZeroAmount();
        if (address(assetRegistry) != address(0)) {
            assetRegistry.validateDeposit(_token, AssetRegistry.AssetType.ERC1155);
        }

        IERC1155(_token).safeTransferFrom(msg.sender, address(this), _id, _amount, "");
        emit ERC1155Deposited(_token, msg.sender, _id, _amount);
    }

    function transferETH(address payable _to, uint256 _amount) external onlyController nonReentrant {
        emergencyPause.requireNotPaused();
        if (_to == address(0)) revert TreasuryVault__ZeroAddress();
        if (_amount == 0) revert TreasuryVault__ZeroAmount();
        if (address(this).balance < _amount) revert TreasuryVault__InsufficientBalance();

        (bool success, ) = _to.call{value: _amount}("");
        if (!success) revert TreasuryVault__TransferFailed();

        emit FundsWithdrawn(_to, _amount);
    }

    function transferERC20(
        address _token,
        address _to,
        uint256 _amount
    ) external onlyController nonReentrant {
        emergencyPause.requireNotPaused();
        if (_token == address(0) || _to == address(0)) revert TreasuryVault__ZeroAddress();
        if (_amount == 0) revert TreasuryVault__ZeroAmount();
        if (address(assetRegistry) != address(0)) {
            assetRegistry.validateWithdrawal(_token, AssetRegistry.AssetType.ERC20, _amount);
        }
        if (IERC20(_token).balanceOf(address(this)) < _amount) {
            revert TreasuryVault__InsufficientBalance();
        }

        IERC20(_token).safeTransfer(_to, _amount);
        emit ERC20FundsWithdrawn(_token, _to, _amount);
    }

    function transferERC721(
        address _token,
        address _to,
        uint256 _tokenId
    ) external onlyController nonReentrant {
        emergencyPause.requireNotPaused();
        if (_token == address(0) || _to == address(0)) revert TreasuryVault__ZeroAddress();
        if (address(assetRegistry) != address(0)) {
            assetRegistry.validateWithdrawal(_token, AssetRegistry.AssetType.ERC721, 1);
        }

        IERC721(_token).safeTransferFrom(address(this), _to, _tokenId);
        emit ERC721Withdrawn(_token, _to, _tokenId);
    }

    function transferERC1155(
        address _token,
        address _to,
        uint256 _id,
        uint256 _amount
    ) external onlyController nonReentrant {
        emergencyPause.requireNotPaused();
        if (_token == address(0) || _to == address(0)) revert TreasuryVault__ZeroAddress();
        if (_amount == 0) revert TreasuryVault__ZeroAmount();
        if (address(assetRegistry) != address(0)) {
            assetRegistry.validateWithdrawal(_token, AssetRegistry.AssetType.ERC1155, _amount);
        }
        if (IERC1155(_token).balanceOf(address(this), _id) < _amount) {
            revert TreasuryVault__InsufficientBalance();
        }

        IERC1155(_token).safeTransferFrom(address(this), _to, _id, _amount, "");
        emit ERC1155Withdrawn(_token, _to, _id, _amount);
    }

    /**
     * @dev Enforces AssetRegistry vetting even on direct safeTransferFrom ERC721 / Hierarchical NFT deposits.
     */
    function onERC721Received(
        address operator,
        address from,
        uint256 tokenId,
        bytes memory data
    ) public virtual override returns (bytes4) {
        if (address(assetRegistry) != address(0)) {
            assetRegistry.validateDeposit(msg.sender, AssetRegistry.AssetType.ERC721);
        }
        return super.onERC721Received(operator, from, tokenId, data);
    }

    /**
     * @dev Enforces AssetRegistry vetting even on direct safeTransferFrom ERC1155 deposits.
     */
    function onERC1155Received(
        address operator,
        address from,
        uint256 id,
        uint256 value,
        bytes memory data
    ) public virtual override returns (bytes4) {
        if (address(assetRegistry) != address(0)) {
            assetRegistry.validateDeposit(msg.sender, AssetRegistry.AssetType.ERC1155);
        }
        return super.onERC1155Received(operator, from, id, value, data);
    }

    function onERC1155BatchReceived(
        address operator,
        address from,
        uint256[] memory ids,
        uint256[] memory values,
        bytes memory data
    ) public virtual override returns (bytes4) {
        if (address(assetRegistry) != address(0)) {
            assetRegistry.validateDeposit(msg.sender, AssetRegistry.AssetType.ERC1155);
        }
        return super.onERC1155BatchReceived(operator, from, ids, values, data);
    }

    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }

    function getERC20Balance(address _token) external view returns (uint256) {
        if (_token == address(0)) revert TreasuryVault__ZeroAddress();
        return IERC20(_token).balanceOf(address(this));
    }
}