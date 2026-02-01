// Simple Audio Manager using Web Audio API
class GameAudio {
    constructor() {
        this.context = null;
        this.enabled = true;
        this.init();
    }

    init() {
        try {
            this.context = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
            console.warn('Web Audio not supported');
        }
    }

    playTone(frequency, duration, type = 'sine') {
        if (!this.enabled || !this.context) return;

        const osc = this.context.createOscillator();
        const gain = this.context.createGain();

        osc.connect(gain);
        gain.connect(this.context.destination);

        osc.type = type;
        osc.frequency.value = frequency;

        gain.gain.setValueAtTime(0.3, this.context.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.context.currentTime + duration);

        osc.start(this.context.currentTime);
        osc.stop(this.context.currentTime + duration);
    }

    playFlap() {
        this.playTone(300, 0.1, 'square');
    }

    playScore() {
        this.playTone(600, 0.15);
    }

    playCoin() {
        if (!this.context) return;
        const osc = this.context.createOscillator();
        const gain = this.context.createGain();
        osc.connect(gain);
        gain.connect(this.context.destination);

        osc.frequency.setValueAtTime(800, this.context.currentTime);
        osc.frequency.exponentialRampToValueAtTime(1200, this.context.currentTime + 0.1);

        gain.gain.setValueAtTime(0.3, this.context.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.context.currentTime + 0.1);

        osc.start(this.context.currentTime);
        osc.stop(this.context.currentTime + 0.1);
    }

    playPowerup() {
        this.playTone(1000, 0.2);
    }

    playHit() {
        this.playTone(150, 0.3, 'sawtooth');
    }

    playDeath() {
        if (!this.context) return;
        const osc = this.context.createOscillator();
        const gain = this.context.createGain();
        osc.connect(gain);
        gain.connect(this.context.destination);

        osc.frequency.setValueAtTime(400, this.context.currentTime);
        osc.frequency.exponentialRampToValueAtTime(100, this.context.currentTime + 0.5);

        gain.gain.setValueAtTime(0.4, this.context.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.context.currentTime + 0.5);

        osc.start(this.context.currentTime);
        osc.stop(this.context.currentTime + 0.5);
    }

    toggle() {
        this.enabled = !this.enabled;
    }
}

const gameAudio = new GameAudio();
