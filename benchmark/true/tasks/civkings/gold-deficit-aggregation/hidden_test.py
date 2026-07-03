"""Hidden scoring test (never shown to the agent)."""
from gold_management import GoldManagement


def test_monthly_surplus_subtracts_all_expense_sources():
    gold = GoldManagement()

    # Two maintained units: Knight (3.0) + Archer (1.0) = 4.0 maintenance
    gold.add_unit("kn1", "Knight")
    gold.add_unit("ar1", "Archer")

    # Three conquered cities: 3 * TRIBUTE_PER_CITY(10.0) = 30.0 tribute
    gold.add_conquered_city(3)

    # Standing bribery cost
    gold.bribery_total = 5.0

    summary = gold.process_monthly_expenses(income=100)

    # All three expense sources must be aggregated.
    assert summary["unit_maintenance"] == 4.0
    assert summary["tribute"] == 30.0
    assert summary["bribery"] == 5.0
    assert summary["total_expenses"] == 39.0

    # Surplus is income minus the full expense total: 100 - 39 = 61
    assert summary["surplus_deficit"] == 61.0
