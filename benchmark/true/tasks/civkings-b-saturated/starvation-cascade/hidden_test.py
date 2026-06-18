"""Hidden grading test for the `starvation-cascade` benchmark task.

CivKings cities grow when they have a food surplus, but historically there
was no consequence when food production fell below the population's
consumption.  These tests verify that a real "starvation cascade" exists:

  * a sustained food deficit makes the city LOSE population over turns,
  * a starving city suffers a per-city happiness penalty,
  * a severe / sustained deficit drags the city's stability below its
    well-fed baseline,
  * a well-fed city still grows normally (regression guard),
  * population never collapses below a floor of 1 (a city is never wiped
    out to zero purely by starvation).

Everything is exercised through the real `City` API (`grow()` and
`calculate_yields()`), on a TEMPERATE, non-coastal city so that every
climate / coastal multiplier is exactly 1.0 and the food math is fully
deterministic:

    food        == 2.0 + population * 0.5
    consumption == population * 1.5

The assertions are relational (compare against the city's own starting
state / its own well-fed baseline) so they do not hard-code the
implementation's chosen thresholds or penalty magnitudes.
"""
import os

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _city(population):
    """A deterministic TEMPERATE, non-coastal city at a given population."""
    from city import City
    from game_data import ClimateZone

    return City(
        name="Testopolis",
        owner="p1",
        position=(0, 0),
        population=population,
        climate_zone=ClimateZone.TEMPERATE,
        is_coastal=False,
    )


def _food_and_consumption(city):
    """Return (food_income, consumption) for the city this turn."""
    yields = city.calculate_yields()
    return yields.get("food", 0.0), city.population * 1.5


def _stability(city):
    return city.calculate_yields().get("stability", 0.0)


# ---------------------------------------------------------------------------
# (a) A sustained food deficit drains population over turns.
# ---------------------------------------------------------------------------

def test_food_deficit_drains_population():
    # pop 16 TEMPERATE: food = 2 + 8 = 10, consumption = 24 -> deep deficit.
    city = _city(16)
    food, consumption = _food_and_consumption(city)
    assert food < consumption, "test setup must be a genuine food deficit"

    start_pop = city.population
    for _ in range(10):
        city.grow()

    assert city.population < start_pop, (
        "a city running a sustained food deficit must lose population over "
        f"turns (started at {start_pop}, still at {city.population})"
    )


# ---------------------------------------------------------------------------
# (b) A starving city takes a happiness penalty.
# ---------------------------------------------------------------------------

def test_starvation_applies_happiness_penalty():
    city = _city(16)
    food, consumption = _food_and_consumption(city)
    assert food < consumption, "test setup must be a genuine food deficit"

    happiness_before = city.happiness
    # Let the deficit bite for several turns.
    for _ in range(5):
        city.grow()

    assert city.happiness < happiness_before, (
        "a starving city must suffer a happiness penalty (happiness went "
        f"from {happiness_before} to {city.happiness})"
    )


# ---------------------------------------------------------------------------
# (c) Severe / sustained starvation drags stability below the well-fed
#     baseline.
# ---------------------------------------------------------------------------

def test_severe_starvation_reduces_stability():
    # Baseline stability of a perfectly healthy, well-fed city.
    well_fed_baseline = _stability(_city(1))

    city = _city(16)
    food, consumption = _food_and_consumption(city)
    assert food < consumption, "test setup must be a genuine food deficit"

    # Sustain the severe deficit for many turns.
    for _ in range(8):
        city.grow()

    assert _stability(city) < well_fed_baseline, (
        "severe, sustained starvation must reduce the city's stability below "
        f"its well-fed baseline ({well_fed_baseline})"
    )


# ---------------------------------------------------------------------------
# (d) Regression guard: a well-fed city still grows.
# ---------------------------------------------------------------------------

def test_well_fed_city_still_grows():
    # pop 1 TEMPERATE: food = 2.5 > consumption 1.5 -> healthy surplus.
    city = _city(1)
    food, consumption = _food_and_consumption(city)
    assert food > consumption, "test setup must be a genuine food surplus"

    start_pop = city.population
    for _ in range(5):
        city.grow()

    assert city.population > start_pop, (
        "a well-fed city must still be able to grow (started at "
        f"{start_pop}, still at {city.population})"
    )


# ---------------------------------------------------------------------------
# (e) Population floor: starvation never wipes a city to zero.
# ---------------------------------------------------------------------------

def test_starvation_respects_population_floor():
    # Small city in deficit: pop 4 -> food = 4, consumption = 6.
    city = _city(4)
    food, consumption = _food_and_consumption(city)
    assert food < consumption, "test setup must be a genuine food deficit"

    # Grind for far more turns than the city has population.
    for _ in range(40):
        city.grow()

    assert city.population >= 1, (
        "starvation must never drop a city's population below 1 "
        f"(got {city.population})"
    )
