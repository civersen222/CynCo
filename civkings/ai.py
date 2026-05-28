import random


class AI:
    def __init__(self, civilization):
        self.civilization = civilization
        self.expansion_priority = 1.0
        self.research_priority = 0.7
        self.military_priority = 0.5

    def get_expansion_priority(self, num_cities):
        adj = {"expansion": max(0, 0.8 - 0.2 * num_cities)}
        adj["expansion"] -= 0.1
        if num_cities < 4:
            adj["expansion"] += max(0, 0.8 - 0.2 * num_cities)
        if adj["expansion"] < 0:
            adj["expansion"] = 0
        return adj["expansion"]

    def decide_action(self):
        expansion = self.get_expansion_priority(self.civilization.num_cities)
        if expansion > self.research_priority:
            return "expand"
        elif expansion > self.military_priority:
            return "research"
        else:
            return "military"

    def build_unit(self, unit_type):
        self.civilization.build_unit(unit_type)

    def research_tech(self, tech_id):
        self.civilization.research(tech_id)
