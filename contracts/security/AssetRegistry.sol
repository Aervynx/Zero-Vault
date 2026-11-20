// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "../access/RoleManager.sol";

/**
 * @title AssetRegistry
 * @author ZeroVault Lead Architect
 * @notice On-chain security gatekeeper for multi-asset custody (ERC20, RWA, ERC721, Hierarchical NFTs, ERC1155).
 * @dev Enforces contract/interface verification (ERC-165), strict asset allowlisting,
 *      per-asset withdrawal caps, and guardian-triggered per-asset circuit breakers.
 */
contract AssetRegistry {
    enum AssetType {
        None,
        ERC20,
        RWA_ERC20,
        ERC721,
        HierarchicalNFT,
        ERC1155
    }

    struct AssetConfig {
        AssetType assetType;
        bool allowed;
        bool frozen;
        uint256 maxSingleWithdrawal; // 0 = no cap (typically used for ERC20/RWA)
    }

    RoleManager public immutable roleManager;
    bool public enforceAllowlist;

    mapping(address => AssetConfig) public assets;

    event AssetRegistered(
        address indexed asset,
        AssetType indexed assetType,
        uint256 maxSingleWithdrawal,
        address indexed registeredBy
    );
    event AssetAllowanceUpdated(address indexed asset, bool allowed, address indexed updatedBy);
    event AssetCapUpdated(address indexed asset, uint256 oldCap, uint256 newCap);
    event AssetFrozen(address indexed asset, address indexed frozenBy);
    event AssetUnfrozen(address indexed asset, address indexed unfrozenBy);
    event AllowlistEnforcementUpdated(bool enforced, address indexed updatedBy);

    error AssetRegistry__ZeroAddress();
    error AssetRegistry__Unauthorized();
    error AssetRegistry__NotAContract(address asset);
    error AssetRegistry__InvalidAssetType();
    error AssetRegistry__InvalidInterface(address asset, AssetType assetType);
    error AssetRegistry__AssetNotRegistered(address asset);
    error AssetRegistry__AssetNotAllowed(address asset);
    error AssetRegistry__AssetFrozen(address asset);
    error AssetRegistry__AssetNotFrozen(address asset);
    error AssetRegistry__AssetTypeMismatch(address asset, AssetType actual, AssetType expected);
    error AssetRegistry__ExceedsWithdrawalCap(address asset, uint256 amount, uint256 cap);

    constructor(address _roleManager, bool _enforceAllowlist) {
        if (_roleManager == address(0)) revert AssetRegistry__ZeroAddress();
        roleManager = RoleManager(_roleManager);
        enforceAllowlist = _enforceAllowlist;
    }

    /**
     * @notice Registers and vets an asset contract on-chain.
     * @dev Callable by BUDGET_MANAGER_ROLE or DEFAULT_ADMIN_ROLE.
     *      Verifies contract code presence and ERC-165 interfaces for NFTs/ERC-1155.
     */
    function registerAsset(
        address asset,
        AssetType assetType,
        uint256 maxSingleWithdrawal
    ) external {
        if (!roleManager.isBudgetManager(msg.sender) && !roleManager.isAdmin(msg.sender)) {
            revert AssetRegistry__Unauthorized();
        }
        if (asset == address(0)) revert AssetRegistry__ZeroAddress();
        if (assetType == AssetType.None) revert AssetRegistry__InvalidAssetType();
        if (asset.code.length == 0) revert AssetRegistry__NotAContract(asset);

        if (assetType == AssetType.ERC721 || assetType == AssetType.HierarchicalNFT) {
            _requireERC165(asset, type(IERC721).interfaceId, assetType);
        } else if (assetType == AssetType.ERC1155) {
            _requireERC165(asset, type(IERC1155).interfaceId, assetType);
        }

        assets[asset] = AssetConfig({
            assetType: assetType,
            allowed: true,
            frozen: false,
            maxSingleWithdrawal: maxSingleWithdrawal
        });

        emit AssetRegistered(asset, assetType, maxSingleWithdrawal, msg.sender);
    }

    /**
     * @notice Enables or disables an already-registered asset.
     */
    function setAssetAllowed(address asset, bool allowed) external {
        if (!roleManager.isBudgetManager(msg.sender) && !roleManager.isAdmin(msg.sender)) {
            revert AssetRegistry__Unauthorized();
        }
        if (assets[asset].assetType == AssetType.None) {
            revert AssetRegistry__AssetNotRegistered(asset);
        }
        assets[asset].allowed = allowed;
        emit AssetAllowanceUpdated(asset, allowed, msg.sender);
    }

    /**
     * @notice Updates the per-transaction withdrawal cap for a registered asset.
     */
    function setMaxSingleWithdrawal(address asset, uint256 newCap) external {
        if (!roleManager.isBudgetManager(msg.sender) && !roleManager.isAdmin(msg.sender)) {
            revert AssetRegistry__Unauthorized();
        }
        if (assets[asset].assetType == AssetType.None) {
            revert AssetRegistry__AssetNotRegistered(asset);
        }
        uint256 oldCap = assets[asset].maxSingleWithdrawal;
        assets[asset].maxSingleWithdrawal = newCap;
        emit AssetCapUpdated(asset, oldCap, newCap);
    }

    /**
     * @notice Emergency per-asset circuit breaker. Callable by GUARDIAN_ROLE or DEFAULT_ADMIN_ROLE.
     */
    function freezeAsset(address asset) external {
        if (!roleManager.isGuardian(msg.sender) && !roleManager.isAdmin(msg.sender)) {
            revert AssetRegistry__Unauthorized();
        }
        if (asset == address(0)) revert AssetRegistry__ZeroAddress();
        if (assets[asset].frozen) revert AssetRegistry__AssetFrozen(asset);

        assets[asset].frozen = true;
        emit AssetFrozen(asset, msg.sender);
    }

    /**
     * @notice Unfreezes a previously frozen asset. Strictly restricted to DEFAULT_ADMIN_ROLE.
     */
    function unfreezeAsset(address asset) external {
        if (!roleManager.isAdmin(msg.sender)) revert AssetRegistry__Unauthorized();
        if (!assets[asset].frozen) revert AssetRegistry__AssetNotFrozen(asset);

        assets[asset].frozen = false;
        emit AssetUnfrozen(asset, msg.sender);
    }

    /**
     * @notice Toggles strict allowlist enforcement. Strictly restricted to DEFAULT_ADMIN_ROLE.
     */
    function setEnforceAllowlist(bool enforced) external {
        if (!roleManager.isAdmin(msg.sender)) revert AssetRegistry__Unauthorized();
        enforceAllowlist = enforced;
        emit AllowlistEnforcementUpdated(enforced, msg.sender);
    }

    /**
     * @notice Validates whether an asset can be deposited via the specified transfer lane.
     */
    function validateDeposit(address asset, AssetType lane) external view {
        if (asset == address(0)) revert AssetRegistry__ZeroAddress();
        AssetConfig storage cfg = assets[asset];
        if (cfg.frozen) revert AssetRegistry__AssetFrozen(asset);

        if (enforceAllowlist) {
            if (!cfg.allowed) revert AssetRegistry__AssetNotAllowed(asset);
            if (!_matchesLane(cfg.assetType, lane)) {
                revert AssetRegistry__AssetTypeMismatch(asset, cfg.assetType, lane);
            }
        }
    }

    /**
     * @notice Validates whether an asset and amount can be withdrawn via the specified transfer lane.
     */
    function validateWithdrawal(address asset, AssetType lane, uint256 amount) external view {
        if (asset == address(0)) revert AssetRegistry__ZeroAddress();
        AssetConfig storage cfg = assets[asset];
        if (cfg.frozen) revert AssetRegistry__AssetFrozen(asset);

        if (enforceAllowlist) {
            if (!cfg.allowed) revert AssetRegistry__AssetNotAllowed(asset);
            if (!_matchesLane(cfg.assetType, lane)) {
                revert AssetRegistry__AssetTypeMismatch(asset, cfg.assetType, lane);
            }
        }

        if (cfg.maxSingleWithdrawal > 0 && amount > cfg.maxSingleWithdrawal) {
            revert AssetRegistry__ExceedsWithdrawalCap(asset, amount, cfg.maxSingleWithdrawal);
        }
    }

    function _matchesLane(AssetType actual, AssetType lane) internal pure returns (bool) {
        if (lane == AssetType.ERC20) {
            return actual == AssetType.ERC20 || actual == AssetType.RWA_ERC20;
        }
        if (lane == AssetType.ERC721) {
            return actual == AssetType.ERC721 || actual == AssetType.HierarchicalNFT;
        }
        return actual == lane;
    }

    function _requireERC165(address asset, bytes4 interfaceId, AssetType assetType) internal view {
        try IERC165(asset).supportsInterface(interfaceId) returns (bool supported) {
            if (!supported) revert AssetRegistry__InvalidInterface(asset, assetType);
        } catch {
            revert AssetRegistry__InvalidInterface(asset, assetType);
        }
    }
}