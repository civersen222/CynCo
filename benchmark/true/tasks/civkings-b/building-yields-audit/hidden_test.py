"""Hidden scoring test (never shown to the agent).

Verifies that ``City.calculate_yields()`` surfaces EVERY declared effect field of
every placed building into the returned yields dictionary, generically.

At the pinned green ref, ``calculate_yields`` reads each building's
food/gold/science/production/faith/culture into the result, but the declared
``happiness`` and ``defense_bonus`` fields never reach the returned dict -- so a
building like Theater (declares happiness) or Wall/Barracks (declare
defense_bonus) contributes nothing observable to the city's yields for those
fields. A correct fix iterates the building's declared effect fields generically
and adds every positive one to the result, without breaking the
already-working yields, district adjacency, or climate multipliers.

Tests are independent and individually satisfiable so a partial implementation
still scores partial credit. Headless: no pygame surface is created.
"""
import os

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")

from city import City
from game_data import BUILDINGS, ClimateZone, BuildingType

# The full set of declared effect fields on a BuildingType that represent a
# positive contribution to a city. (defense_bonus may surface under either
# "defense" or "defense_bonus" in the yields dict.)
EFFECT_FIELDS = ("food", "production", "gold", "science", "faith", "culture",
                 "happiness", "defense_bonus")

# Output keys that may legitimately carry defense_bonus.
DEFENSE_KEYS = ("defense_bonus", "defense")


def _fresh_city(climate=ClimateZone.TEMPERATE):
    return City("Test", "player", (0, 0), climate_zone=climate)


def _yields_for(building, climate=ClimateZone.TEMPERATE):
    c = _fresh_city(climate)
    c.add_building(building)
    return c.calculate_yields()


def _baseline(climate=ClimateZone.TEMPERATE):
    return _fresh_city(climate).calculate_yields()


def _output_value(yields, field):
    """Read the output-dict value for a declared field, allowing for the
    defense_bonus -> defense key aliasing."""
    if field == "defense_bonus":
        for k in DEFENSE_KEYS:
            if k in yields:
                return yields[k]
        return None
    return yields.get(field)


def test_declared_happiness_reaches_yields():
    """A building that declares a happiness effect must surface that happiness
    in the returned yields dictionary by the declared amount."""
    # Find a building that declares positive happiness (Theater at green).
    candidates = [b for b in BUILDINGS.values() if getattr(b, "happiness", 0) > 0]
    assert candidates, "expected at least one building declaring happiness"
    b = candidates[0]

    base = _baseline()
    got = _yields_for(b)

    assert "happiness" in got, (
        f"{b.name} declares happiness={b.happiness} but 'happiness' is absent "
        f"from calculate_yields() output keys {sorted(got)}"
    )
    delta = got["happiness"] - base.get("happiness", 0)
    assert abs(delta - b.happiness) < 1e-6, (
        f"{b.name} declares happiness={b.happiness} but yields changed by {delta}"
    )


def test_declared_defense_reaches_yields():
    """A building that declares a defense bonus must surface it in yields."""
    candidates = [b for b in BUILDINGS.values()
                  if getattr(b, "defense_bonus", 0) > 0]
    assert candidates, "expected at least one building declaring defense_bonus"
    b = candidates[0]

    base = _baseline()
    got = _yields_for(b)

    base_def = _output_value(base, "defense_bonus") or 0
    got_def = _output_value(got, "defense_bonus")
    assert got_def is not None, (
        f"{b.name} declares defense_bonus={b.defense_bonus} but neither "
        f"'defense' nor 'defense_bonus' appears in output keys {sorted(got)}"
    )
    delta = got_def - base_def
    assert abs(delta - b.defense_bonus) < 1e-6, (
        f"{b.name} declares defense_bonus={b.defense_bonus} but yields changed "
        f"by {delta}"
    )


def test_every_declared_effect_reflected_generically():
    """For each building, every positive declared effect field must move the
    corresponding output entry by the declared amount (temperate, so climate
    multipliers are all 1.0 and do not confound the comparison)."""
    base = _baseline()
    failures = []
    for name, b in BUILDINGS.items():
        got = _yields_for(b)
        for field in EFFECT_FIELDS:
            declared = getattr(b, field, 0)
            if declared <= 0:
                continue
            out = _output_value(got, field)
            if out is None:
                failures.append(f"{name}.{field}={declared} -> key absent")
                continue
            base_val = _output_value(base, field) or 0
            delta = out - base_val
            if abs(delta - declared) > 1e-6:
                failures.append(
                    f"{name}.{field}={declared} -> delta {delta}"
                )
    assert not failures, "declared effects not reflected: " + "; ".join(failures)


def test_existing_yields_and_climate_not_regressed():
    """Regression guard: an already-working yield (science from Library) plus a
    non-temperate climate multiplier must still be exact, with no double-count.

    Library declares science=2. A temperate city's science output with a Library
    must be exactly base_science + 2. Under a climate whose science multiplier is
    1.0 (TROPICAL at green) the building contribution must still be exactly +2 --
    proving the building yield is added once and the climate stage still runs.
    """
    lib = BUILDINGS["Library"]
    assert lib.science > 0

    # Temperate: exact additive contribution, no double count.
    base_t = _baseline(ClimateZone.TEMPERATE)
    got_t = _yields_for(lib, ClimateZone.TEMPERATE)
    assert abs((got_t["science"] - base_t["science"]) - lib.science) < 1e-6, (
        "Library science contribution changed under temperate climate"
    )

    # A climate stage must still be applied: food multiplier differs from 1.0
    # under TROPICAL, so the baseline food must scale accordingly (proves climate
    # multipliers were not removed while wiring building effects).
    base_tropical = _baseline(ClimateZone.TROPICAL)
    assert base_tropical["food"] > base_t["food"], (
        "tropical food multiplier (1.2) no longer applied -- climate stage broke"
    )

    # And the Library's science contribution under tropical (science mult 1.0)
    # is still exactly +2, i.e. not double counted by any new generic loop.
    got_tropical = _yields_for(lib, ClimateZone.TROPICAL)
    assert abs((got_tropical["science"] - base_tropical["science"]) - lib.science) < 1e-6
