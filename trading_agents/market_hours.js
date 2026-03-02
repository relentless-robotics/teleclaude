/**
 * Market Hours Utility
 *
 * Handles all market time calculations, trading day detection,
 * and scheduling logic.
 */

const config = require('./config');

// US Market Holidays 2026 (NYSE/NASDAQ closed)
const MARKET_HOLIDAYS_2026 = [
  '2026-01-01', // New Year's Day
  '2026-01-19', // MLK Day
  '2026-02-16', // Presidents Day
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-07-03', // Independence Day (observed)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas
];

// Early close days (1 PM ET)
const EARLY_CLOSE_2026 = [
  '2026-11-27', // Day after Thanksgiving
  '2026-12-24', // Christmas Eve
];

class MarketHours {
  constructor() {
    this.timezone = config.marketHours.timezone;
  }

  /**
   * Get current time in Eastern Time
   */
  getETTime() {
    return new Date().toLocaleString('en-US', { timeZone: this.timezone });
  }

  /**
   * Get current hour and minute in ET
   */
  getETHourMinute() {
    const etTime = new Date(this.getETTime());
    return {
      hour: etTime.getHours(),
      minute: etTime.getMinutes(),
      time: `${etTime.getHours().toString().padStart(2, '0')}:${etTime.getMinutes().toString().padStart(2, '0')}`,
    };
  }

  /**
   * Get today's date in YYYY-MM-DD format
   */
  getTodayET() {
    // Use en-CA locale which formats as YYYY-MM-DD, avoids UTC conversion bug
    return new Date().toLocaleDateString('en-CA', { timeZone: this.timezone });
  }

  /**
   * Check if today is a trading day
   */
  isTradingDay(date = null) {
    const checkDate = date || this.getTodayET();
    const dayOfWeek = new Date(checkDate + 'T12:00:00').getDay();

    // Weekend check
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      return false;
    }

    // Holiday check
    if (MARKET_HOLIDAYS_2026.includes(checkDate)) {
      return false;
    }

    return true;
  }

  /**
   * Check if market is currently open
   */
  isMarketOpen() {
    if (!this.isTradingDay()) {
      return false;
    }

    const { hour, minute } = this.getETHourMinute();
    const currentMinutes = hour * 60 + minute;

    const openMinutes = 9 * 60 + 30;  // 9:30 AM
    let closeMinutes = 16 * 60;        // 4:00 PM

    // Check for early close
    if (EARLY_CLOSE_2026.includes(this.getTodayET())) {
      closeMinutes = 13 * 60; // 1:00 PM
    }

    return currentMinutes >= openMinutes && currentMinutes < closeMinutes;
  }

  /**
   * Check if we're in pre-market hours
   */
  isPreMarket() {
    if (!this.isTradingDay()) {
      return false;
    }

    const { hour, minute } = this.getETHourMinute();
    const currentMinutes = hour * 60 + minute;

    const preMarketStart = 7 * 60;    // 7:00 AM
    const marketOpen = 9 * 60 + 30;   // 9:30 AM

    return currentMinutes >= preMarketStart && currentMinutes < marketOpen;
  }

  /**
   * Check if we're in after-hours
   */
  isAfterHours() {
    if (!this.isTradingDay()) {
      return false;
    }

    const { hour, minute } = this.getETHourMinute();
    const currentMinutes = hour * 60 + minute;

    let closeMinutes = 16 * 60;        // 4:00 PM
    const afterHoursEnd = 20 * 60;     // 8:00 PM

    // Check for early close
    if (EARLY_CLOSE_2026.includes(this.getTodayET())) {
      closeMinutes = 13 * 60; // 1:00 PM
    }

    return currentMinutes >= closeMinutes && currentMinutes < afterHoursEnd;
  }

  /**
   * Check if we're in overnight session
   */
  isOvernight() {
    const { hour } = this.getETHourMinute();

    // 8 PM to 7 AM next day
    return hour >= 20 || hour < 7;
  }

  /**
   * Get current market session
   */
  getCurrentSession() {
    if (!this.isTradingDay()) {
      return { session: 'CLOSED', reason: 'Weekend or Holiday' };
    }

    if (this.isPreMarket()) {
      return { session: 'PRE_MARKET', active: true };
    }

    if (this.isMarketOpen()) {
      return { session: 'MARKET_OPEN', active: true };
    }

    if (this.isAfterHours()) {
      return { session: 'AFTER_HOURS', active: true };
    }

    if (this.isOvernight()) {
      return { session: 'OVERNIGHT', active: true };
    }

    return { session: 'CLOSED', reason: 'Outside trading hours' };
  }

  /**
   * Get time until next market event
   */
  getNextEvent() {
    const { hour, minute } = this.getETHourMinute();
    const currentMinutes = hour * 60 + minute;

    if (!this.isTradingDay()) {
      // Find next trading day
      let nextDay = new Date(this.getTodayET() + 'T12:00:00');
      do {
        nextDay.setDate(nextDay.getDate() + 1);
      } while (!this.isTradingDay(nextDay.toISOString().split('T')[0]));

      return {
        event: 'MARKET_OPEN',
        date: nextDay.toISOString().split('T')[0],
        time: '09:30',
      };
    }

    const events = [
      { name: 'PRE_MARKET_START', minutes: 7 * 60 },
      { name: 'MARKET_OPEN', minutes: 9 * 60 + 30 },
      { name: 'MARKET_CLOSE', minutes: 16 * 60 },
      { name: 'AFTER_HOURS_END', minutes: 20 * 60 },
    ];

    for (const event of events) {
      if (currentMinutes < event.minutes) {
        const minutesUntil = event.minutes - currentMinutes;
        return {
          event: event.name,
          minutesUntil,
          hoursUntil: (minutesUntil / 60).toFixed(1),
        };
      }
    }

    return { event: 'NEXT_DAY', minutesUntil: null };
  }

  /**
   * Check if a specific agent should be running now
   */
  shouldAgentRun(agentName) {
    const agentConfig = config.agents[agentName];
    if (!agentConfig || !agentConfig.enabled) {
      return { run: false, reason: 'Agent disabled' };
    }

    const { time } = this.getETHourMinute();
    const schedule = agentConfig.schedule;

    // Parse times
    const currentMinutes = this.timeToMinutes(time);
    const startMinutes = this.timeToMinutes(schedule.start);
    const endMinutes = this.timeToMinutes(schedule.end);

    // Handle overnight agents (end < start)
    if (endMinutes < startMinutes) {
      // Overnight period (e.g., 20:00 to 07:00)
      if (currentMinutes >= startMinutes || currentMinutes < endMinutes) {
        return { run: true, reason: 'Within overnight schedule' };
      }
    } else {
      // Normal daytime period
      if (currentMinutes >= startMinutes && currentMinutes < endMinutes) {
        return { run: true, reason: 'Within schedule' };
      }
    }

    return { run: false, reason: 'Outside schedule' };
  }

  /**
   * Convert time string to minutes since midnight
   */
  timeToMinutes(timeStr) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
  }

  /**
   * Get status summary
   */
  getStatus() {
    const session = this.getCurrentSession();
    const nextEvent = this.getNextEvent();
    const { time } = this.getETHourMinute();

    return {
      currentTimeET: time,
      date: this.getTodayET(),
      isTradingDay: this.isTradingDay(),
      session: session.session,
      isMarketOpen: this.isMarketOpen(),
      nextEvent,
      agents: {
        preMarket: this.shouldAgentRun('preMarket'),
        swingScanner: this.shouldAgentRun('swingScanner'),
        afterHours: this.shouldAgentRun('afterHours'),
        overnight: this.shouldAgentRun('overnight'),
      },
    };
  }
}

module.exports = new MarketHours();
