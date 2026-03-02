// Powerups Data and Configuration
const POWERUPS = {
    shield: { icon: '🛡️', name: 'Shield', duration: 0 },
    fire: { icon: '🔥', name: 'Fire Mode', duration: 5000 },
    slowmo: { icon: '⏱️', name: 'Slow-Mo', duration: 5000 },
    magnet: { icon: '🧲', name: 'Magnet', duration: 5000 },
    ghost: { icon: '👻', name: 'Ghost', duration: 3000 },
    tiny: { icon: '🌀', name: 'Tiny Bird', duration: 5000 }
};

const SKINS = {
    classic: { icon: '🐦', name: 'Classic Bird', price: 0 },
    phoenix: { icon: '🔥', name: 'Phoenix', price: 100 },
    ice: { icon: '❄️', name: 'Ice Bird', price: 150 },
    rainbow: { icon: '🌈', name: 'Rainbow Bird', price: 200 },
    golden: { icon: '👑', name: 'Golden Bird', price: 300 },
    skeleton: { icon: '💀', name: 'Skeleton Bird', price: 250 },
    robot: { icon: '🤖', name: 'Robot Bird', price: 350 },
    unicorn: { icon: '🦄', name: 'Unicorn', price: 400 }
};

const UPGRADES = {
    startingShield: { icon: '🛡️', name: 'Starting Shield', price: 500, desc: 'Start with a shield' },
    longerPowerups: { icon: '⏱️', name: 'Longer Powerups', price: 300, desc: '+50% powerup duration' },
    moreCoins: { icon: '💰', name: 'Double Coins', price: 400, desc: '2x coins from pickups' },
    smallerHitbox: { icon: '🌀', name: 'Smaller Hitbox', price: 600, desc: 'Smaller bird hitbox' }
};
