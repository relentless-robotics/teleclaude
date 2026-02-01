"""
Human-Like Browser Behavior Module
Makes browser automation appear more human to avoid bot detection.
"""

import random
import time
import asyncio
from typing import Tuple, Optional


class HumanBehavior:
    """Simulates human-like browser behavior."""

    def __init__(self, speed: str = "normal"):
        """
        Args:
            speed: 'fast', 'normal', or 'slow' - affects all timing
        """
        self.speed_multiplier = {
            'fast': 0.5,
            'normal': 1.0,
            'slow': 1.5
        }.get(speed, 1.0)

    def random_delay(self, min_sec: float = 0.5, max_sec: float = 2.0) -> float:
        """Get a random delay time."""
        delay = random.uniform(min_sec, max_sec) * self.speed_multiplier
        return delay

    def sleep(self, min_sec: float = 0.5, max_sec: float = 2.0):
        """Sleep for a random duration (synchronous)."""
        time.sleep(self.random_delay(min_sec, max_sec))

    async def async_sleep(self, min_sec: float = 0.5, max_sec: float = 2.0):
        """Sleep for a random duration (async)."""
        await asyncio.sleep(self.random_delay(min_sec, max_sec))

    def typing_delay(self, char: str) -> float:
        """Get realistic typing delay for a character."""
        # Base delay
        base = random.uniform(0.05, 0.15)

        # Slower for special characters
        if char in '!@#$%^&*()_+-=[]{}|;:\'",.<>?/\\`~':
            base *= 1.5

        # Occasional pause (thinking)
        if random.random() < 0.05:
            base += random.uniform(0.2, 0.5)

        return base * self.speed_multiplier

    def get_typing_sequence(self, text: str) -> list:
        """
        Get a sequence of (char, delay) tuples for realistic typing.
        Includes occasional typos and corrections.
        """
        sequence = []
        i = 0
        while i < len(text):
            char = text[i]

            # Occasional typo (5% chance)
            if random.random() < 0.05 and char.isalpha():
                # Type wrong character
                wrong_char = self._nearby_key(char)
                sequence.append((wrong_char, self.typing_delay(wrong_char)))
                # Pause to "notice"
                sequence.append(('PAUSE', random.uniform(0.2, 0.4)))
                # Backspace
                sequence.append(('BACKSPACE', 0.1))
                # Type correct character
                sequence.append((char, self.typing_delay(char)))
            else:
                sequence.append((char, self.typing_delay(char)))

            i += 1

        return sequence

    def _nearby_key(self, char: str) -> str:
        """Get a nearby key for typo simulation."""
        keyboard_neighbors = {
            'a': 'sqwz', 'b': 'vghn', 'c': 'xdfv', 'd': 'erfcxs',
            'e': 'rdsw', 'f': 'rtgvcd', 'g': 'tyhbvf', 'h': 'yujnbg',
            'i': 'uojk', 'j': 'uikmnh', 'k': 'ioljm', 'l': 'opk',
            'm': 'njk', 'n': 'bhjm', 'o': 'iplk', 'p': 'ol',
            'q': 'wa', 'r': 'etdf', 's': 'wedxza', 't': 'ryfg',
            'u': 'yihj', 'v': 'cfgb', 'w': 'qeas', 'x': 'zsdc',
            'y': 'tugh', 'z': 'asx'
        }
        neighbors = keyboard_neighbors.get(char.lower(), char)
        typo = random.choice(neighbors) if neighbors else char
        return typo.upper() if char.isupper() else typo

    def mouse_path(
        self,
        start: Tuple[int, int],
        end: Tuple[int, int],
        steps: int = None
    ) -> list:
        """
        Generate a human-like mouse movement path.
        Uses bezier curve for natural movement.
        """
        if steps is None:
            distance = ((end[0] - start[0])**2 + (end[1] - start[1])**2)**0.5
            steps = max(10, int(distance / 10))

        # Control points for bezier curve
        cp1 = (
            start[0] + random.randint(-50, 50),
            start[1] + random.randint(-50, 50)
        )
        cp2 = (
            end[0] + random.randint(-50, 50),
            end[1] + random.randint(-50, 50)
        )

        path = []
        for i in range(steps + 1):
            t = i / steps
            # Cubic bezier formula
            x = (1-t)**3 * start[0] + 3*(1-t)**2*t * cp1[0] + 3*(1-t)*t**2 * cp2[0] + t**3 * end[0]
            y = (1-t)**3 * start[1] + 3*(1-t)**2*t * cp1[1] + 3*(1-t)*t**2 * cp2[1] + t**3 * end[1]

            # Add small random jitter
            x += random.uniform(-2, 2)
            y += random.uniform(-2, 2)

            path.append((int(x), int(y)))

        return path

    def scroll_pattern(self, total_distance: int) -> list:
        """Generate human-like scroll pattern (not smooth/linear)."""
        scrolls = []
        remaining = total_distance
        direction = 1 if total_distance > 0 else -1

        while abs(remaining) > 10:
            # Random scroll amount
            amount = random.randint(50, 200) * direction

            # Occasionally scroll back a bit (reading adjustment)
            if random.random() < 0.1:
                amount = -amount // 3

            # Don't overshoot
            if abs(amount) > abs(remaining):
                amount = remaining

            scrolls.append({
                'delta': amount,
                'delay': random.uniform(0.05, 0.2)
            })

            remaining -= amount

        return scrolls

    def click_offset(self, element_center: Tuple[int, int], element_size: Tuple[int, int]) -> Tuple[int, int]:
        """
        Get a random click position within an element.
        Humans don't click exactly in the center.
        """
        max_offset_x = min(element_size[0] // 3, 20)
        max_offset_y = min(element_size[1] // 3, 10)

        offset_x = random.randint(-max_offset_x, max_offset_x)
        offset_y = random.randint(-max_offset_y, max_offset_y)

        return (
            element_center[0] + offset_x,
            element_center[1] + offset_y
        )

    def reading_time(self, text_length: int) -> float:
        """Estimate human reading time for text."""
        # Average reading speed: 200-300 words per minute
        # Average word length: 5 characters
        words = text_length / 5
        minutes = words / random.uniform(200, 300)
        return minutes * 60 * self.speed_multiplier

    def form_fill_delay(self) -> float:
        """Delay between form fields (looking for next field)."""
        return random.uniform(0.3, 1.0) * self.speed_multiplier


# Playwright integration helpers
async def human_type(page, selector: str, text: str, behavior: HumanBehavior = None):
    """Type text with human-like behavior using Playwright."""
    behavior = behavior or HumanBehavior()

    element = await page.query_selector(selector)
    if not element:
        raise Exception(f"Element not found: {selector}")

    await element.click()
    await behavior.async_sleep(0.2, 0.5)

    sequence = behavior.get_typing_sequence(text)
    for item, delay in sequence:
        if item == 'PAUSE':
            await asyncio.sleep(delay)
        elif item == 'BACKSPACE':
            await page.keyboard.press('Backspace')
            await asyncio.sleep(delay)
        else:
            await page.keyboard.type(item, delay=0)
            await asyncio.sleep(delay)


async def human_click(page, selector: str, behavior: HumanBehavior = None):
    """Click with human-like behavior using Playwright."""
    behavior = behavior or HumanBehavior()

    element = await page.query_selector(selector)
    if not element:
        raise Exception(f"Element not found: {selector}")

    # Get element position and size
    box = await element.bounding_box()
    if not box:
        await element.click()
        return

    center = (box['x'] + box['width']/2, box['y'] + box['height']/2)
    size = (box['width'], box['height'])

    # Get offset click position
    click_pos = behavior.click_offset(center, size)

    # Small delay before clicking
    await behavior.async_sleep(0.1, 0.3)

    # Click at offset position
    await page.mouse.click(click_pos[0], click_pos[1])


# Singleton for convenience
human = HumanBehavior()
