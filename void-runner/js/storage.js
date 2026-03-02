// Storage manager for game data
class Storage {
    constructor() {
        this.data = this.load();
    }

    load() {
        const saved = localStorage.getItem('spicyFlappyBird');
        if (saved) {
            return JSON.parse(saved);
        }
        return {
            highScore: 0,
            coins: 0,
            ownedSkins: ['classic'],
            selectedSkin: 'classic',
            upgrades: {
                startingShield: false,
                longerPowerups: false,
                moreCoins: false,
                smallerHitbox: false
            },
            settings: {
                sound: true,
                music: true
            }
        };
    }

    save() {
        localStorage.setItem('spicyFlappyBird', JSON.stringify(this.data));
    }

    getHighScore() {
        return this.data.highScore;
    }

    setHighScore(score) {
        if (score > this.data.highScore) {
            this.data.highScore = score;
            this.save();
            return true;
        }
        return false;
    }

    getCoins() {
        return this.data.coins;
    }

    addCoins(amount) {
        this.data.coins += amount;
        this.save();
    }

    spendCoins(amount) {
        if (this.data.coins >= amount) {
            this.data.coins -= amount;
            this.save();
            return true;
        }
        return false;
    }

    ownsSkin(skinId) {
        return this.data.ownedSkins.includes(skinId);
    }

    buySkin(skinId) {
        if (!this.data.ownedSkins.includes(skinId)) {
            this.data.ownedSkins.push(skinId);
            this.save();
        }
    }

    getSelectedSkin() {
        return this.data.selectedSkin;
    }

    selectSkin(skinId) {
        if (this.ownsSkin(skinId)) {
            this.data.selectedSkin = skinId;
            this.save();
        }
    }

    hasUpgrade(upgradeId) {
        return this.data.upgrades[upgradeId] || false;
    }

    buyUpgrade(upgradeId) {
        this.data.upgrades[upgradeId] = true;
        this.save();
    }

    getSetting(key) {
        return this.data.settings[key];
    }

    setSetting(key, value) {
        this.data.settings[key] = value;
        this.save();
    }
}

const storage = new Storage();
