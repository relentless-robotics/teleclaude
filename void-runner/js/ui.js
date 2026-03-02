// UI Manager - Handles all screen navigation and updates
class UIManager {
    constructor() {
        this.setupEventListeners();
        this.updateMenuDisplay();
    }

    setupEventListeners() {
        // Main menu
        document.getElementById('play-btn')?.addEventListener('click', () => this.startGame());
        document.getElementById('shop-btn')?.addEventListener('click', () => this.showShop());
        document.getElementById('multiplayer-btn')?.addEventListener('click', () => this.showMultiplayer());
        document.getElementById('settings-btn')?.addEventListener('click', () => this.showSettings());

        // Shop
        document.getElementById('shop-back-btn')?.addEventListener('click', () => this.showMenu());

        // Multiplayer
        document.getElementById('mp-back-btn')?.addEventListener('click', () => this.showMenu());
        document.getElementById('create-room-btn')?.addEventListener('click', () => this.createRoom());
        document.getElementById('join-room-btn')?.addEventListener('click', () => this.joinRoom());
        document.getElementById('start-mp-game-btn')?.addEventListener('click', () => this.startMPGame());

        // Settings
        document.getElementById('settings-back-btn')?.addEventListener('click', () => this.showMenu());
        document.getElementById('sound-toggle')?.addEventListener('change', (e) => {
            storage.setSetting('sound', e.target.checked);
            gameAudio.enabled = e.target.checked;
        });

        // Game over
        document.getElementById('retry-btn')?.addEventListener('click', () => this.retry());
        document.getElementById('menu-btn')?.addEventListener('click', () => this.backToMenu());
    }

    showScreen(screenId) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        document.getElementById(screenId)?.classList.add('active');
    }

    showMenu() {
        this.showScreen('menu-screen');
        this.updateMenuDisplay();
    }

    showShop() {
        this.showScreen('shop-screen');
        this.populateShop();
    }

    showMultiplayer() {
        this.showScreen('multiplayer-screen');
    }

    showSettings() {
        this.showScreen('settings-screen');
        document.getElementById('sound-toggle').checked = storage.getSetting('sound');
    }

    updateMenuDisplay() {
        document.getElementById('menu-high-score').textContent = storage.getHighScore();
    }

    populateShop() {
        document.getElementById('shop-coins').textContent = storage.getCoins();

        // Skins
        const skinsContainer = document.getElementById('skins-container');
        skinsContainer.innerHTML = '';
        Object.keys(SKINS).forEach(skinId => {
            const skin = SKINS[skinId];
            const owned = storage.ownsSkin(skinId);
            const selected = storage.getSelectedSkin() === skinId;
            const item = document.createElement('div');
            item.className = 'shop-item' + (owned ? ' owned' : '') + (selected ? ' selected' : '');
            item.innerHTML = `
                <div class="shop-item-icon">${skin.icon}</div>
                <div class="shop-item-name">${skin.name}</div>
                <div class="shop-item-price">${owned ? (selected ? 'EQUIPPED' : 'SELECT') : `${skin.price} coins`}</div>
            `;
            item.addEventListener('click', () => {
                if (owned) {
                    storage.selectSkin(skinId);
                    this.populateShop();
                } else if (storage.spendCoins(skin.price)) {
                    storage.buySkin(skinId);
                    storage.selectSkin(skinId);
                    this.populateShop();
                }
            });
            skinsContainer.appendChild(item);
        });

        // Upgrades
        const upgradesContainer = document.getElementById('upgrades-container');
        upgradesContainer.innerHTML = '';
        Object.keys(UPGRADES).forEach(upgradeId => {
            const upgrade = UPGRADES[upgradeId];
            const owned = storage.hasUpgrade(upgradeId);
            const item = document.createElement('div');
            item.className = 'shop-item' + (owned ? ' owned' : '');
            item.innerHTML = `
                <div class="shop-item-icon">${upgrade.icon}</div>
                <div class="shop-item-name">${upgrade.name}</div>
                <div class="shop-item-price">${owned ? 'OWNED' : `${upgrade.price} coins`}</div>
            `;
            if (!owned) {
                item.addEventListener('click', () => {
                    if (storage.spendCoins(upgrade.price)) {
                        storage.buyUpgrade(upgradeId);
                        this.populateShop();
                    }
                });
            }
            upgradesContainer.appendChild(item);
        });
    }

    startGame() {
        this.showScreen('menu-screen');
        document.getElementById('hud').classList.remove('hidden');
        if (window.game) game.start();
    }

    retry() {
        this.startGame();
    }

    backToMenu() {
        document.getElementById('hud').classList.add('hidden');
        this.showMenu();
    }

    showGameOver(score, coins) {
        document.getElementById('final-score').textContent = score;
        document.getElementById('final-high-score').textContent = storage.getHighScore();
        document.getElementById('coins-earned').textContent = coins;
        this.showScreen('gameover-screen');
    }

    updateHUD(score, coins) {
        document.getElementById('score-hud').textContent = score;
        document.getElementById('coins-hud').textContent = coins;
    }

    showEventBanner(msg) {
        const banner = document.getElementById('event-banner');
        banner.textContent = msg;
        banner.classList.remove('hidden');
        setTimeout(() => banner.classList.add('hidden'), 2000);
    }

    createRoom() {
        if (window.mpManager) mpManager.createRoom();
    }

    joinRoom() {
        const code = document.getElementById('room-code-input').value.toUpperCase();
        if (code && window.mpManager) mpManager.joinRoom(code);
    }

    startMPGame() {
        if (window.mpManager) mpManager.startGame();
    }
}

const uiManager = new UIManager();
