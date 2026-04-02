# Action → InputState mapping
ACTION_TABLE = [
    # (up, down, left, right, fire)
    (False, False, False, False, False),  # 0:  idle
    (True,  False, False, False, False),  # 1:  forward
    (False, True,  False, False, False),  # 2:  backward
    (False, False, True,  False, False),  # 3:  rotate left
    (False, False, False, True,  False),  # 4:  rotate right
    (True,  False, True,  False, False),  # 5:  forward + left
    (True,  False, False, True,  False),  # 6:  forward + right
    (False, True,  True,  False, False),  # 7:  backward + left
    (False, True,  False, True,  False),  # 8:  backward + right
    (False, False, False, False, True),   # 9:  fire
    (True,  False, False, False, True),   # 10: forward + fire
    (False, True,  False, False, True),   # 11: backward + fire
    (False, False, True,  False, True),   # 12: left + fire
    (False, False, False, True,  True),   # 13: right + fire
    (True,  False, True,  False, True),   # 14: forward + left + fire
    (True,  False, False, True,  True),   # 15: forward + right + fire
    (False, True,  True,  False, True),   # 16: backward + left + fire
    (False, True,  False, True,  True),   # 17: backward + right + fire
]


def decode_action(action: int) -> dict:
    """Convert an action index (0-17) to a dict of input flags."""
    up, down, left, right, fire = ACTION_TABLE[action]
    return {"up": up, "down": down, "left": left, "right": right, "fire": fire}
