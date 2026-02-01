"""
Configuration Management
========================
Load and manage trading bot configuration.
"""

import yaml
from pathlib import Path
from typing import Dict, Any, Optional
import os


def load_config(config_path: str = "config.yaml") -> Dict[str, Any]:
    """
    Load configuration from YAML file.

    Args:
        config_path: Path to config file

    Returns:
        Configuration dictionary
    """
    path = Path(config_path)

    if not path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")

    with open(path, 'r') as f:
        config = yaml.safe_load(f)

    # Replace environment variables
    config = _replace_env_vars(config)

    return config


def save_config(config: Dict[str, Any], config_path: str = "config.yaml") -> None:
    """
    Save configuration to YAML file.

    Args:
        config: Configuration dictionary
        config_path: Path to save to
    """
    with open(config_path, 'w') as f:
        yaml.dump(config, f, default_flow_style=False, sort_keys=False)


def _replace_env_vars(obj: Any) -> Any:
    """Recursively replace ${VAR} with environment variables"""
    if isinstance(obj, dict):
        return {k: _replace_env_vars(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [_replace_env_vars(item) for item in obj]
    elif isinstance(obj, str):
        # Check for ${VAR} pattern
        if obj.startswith("${") and obj.endswith("}"):
            var_name = obj[2:-1]
            return os.environ.get(var_name, obj)
        return obj
    return obj


def get_nested(config: Dict, *keys, default: Any = None) -> Any:
    """
    Get nested config value safely.

    Example:
        get_nested(config, 'risk', 'max_position_size', default=0.1)
    """
    for key in keys:
        if isinstance(config, dict):
            config = config.get(key, default)
        else:
            return default
    return config


class TradingConfig:
    """
    Trading configuration manager with validation.
    """

    def __init__(self, config_path: str = "config.yaml"):
        self.config_path = config_path
        self.config = load_config(config_path)
        self._validate()

    def _validate(self):
        """Validate configuration"""
        required_sections = ['data', 'backtest', 'risk']
        for section in required_sections:
            if section not in self.config:
                raise ValueError(f"Missing required config section: {section}")

    def reload(self):
        """Reload configuration from file"""
        self.config = load_config(self.config_path)
        self._validate()

    # Data settings
    @property
    def data_source(self) -> str:
        return get_nested(self.config, 'data', 'source', default='yahoo')

    @property
    def symbols(self) -> list:
        return get_nested(self.config, 'data', 'symbols', default=['SPY'])

    @property
    def start_date(self) -> str:
        return get_nested(self.config, 'data', 'start_date', default='2020-01-01')

    @property
    def end_date(self) -> str:
        return get_nested(self.config, 'data', 'end_date', default='2024-01-01')

    # Backtest settings
    @property
    def initial_capital(self) -> float:
        return get_nested(self.config, 'backtest', 'initial_capital', default=100000)

    @property
    def commission(self) -> float:
        return get_nested(self.config, 'backtest', 'commission', default=0.001)

    @property
    def slippage(self) -> float:
        return get_nested(self.config, 'backtest', 'slippage', default=0.0005)

    # Risk settings
    @property
    def max_position_size(self) -> float:
        return get_nested(self.config, 'risk', 'max_position_size', default=0.1)

    @property
    def max_drawdown(self) -> float:
        return get_nested(self.config, 'risk', 'max_drawdown', default=0.15)

    @property
    def stop_loss_pct(self) -> float:
        return get_nested(self.config, 'risk', 'stop_loss_pct', default=0.02)

    # Live trading
    @property
    def broker(self) -> str:
        return get_nested(self.config, 'live', 'broker', default='alpaca')

    @property
    def paper_trading(self) -> bool:
        return get_nested(self.config, 'live', 'paper', default=True)

    @property
    def alpaca_api_key(self) -> Optional[str]:
        return get_nested(self.config, 'live', 'alpaca', 'api_key')

    @property
    def alpaca_secret(self) -> Optional[str]:
        return get_nested(self.config, 'live', 'alpaca', 'api_secret')


# Quick test
if __name__ == "__main__":
    # Create sample config
    sample_config = {
        'data': {
            'source': 'yahoo',
            'symbols': ['AAPL', 'MSFT'],
            'start_date': '2020-01-01'
        },
        'backtest': {
            'initial_capital': 100000,
            'commission': 0.001
        },
        'risk': {
            'max_position_size': 0.1,
            'max_drawdown': 0.15
        }
    }

    # Save and load
    save_config(sample_config, 'test_config.yaml')
    loaded = load_config('test_config.yaml')
    print("Config loaded successfully:")
    print(yaml.dump(loaded, default_flow_style=False))

    # Cleanup
    Path('test_config.yaml').unlink()
