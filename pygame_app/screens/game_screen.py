import pygame
from pygame_app.screens.base_screen import BaseScreen


class GameScreen(BaseScreen):
    def __init__(self, game):
        super().__init__()
        self.game = game
        self._needs_map_redraw = True

    def handle_event(self, event):
        if event.type == pygame.KEYDOWN:
            if event.key == pygame.K_SPACE:
                combat_result = self.game.combat_manager.start_combat()
                popup = CombatPopup(combat_result.description)
                popup.show()
                if combat_result.winner:
                    self._apply_combat_result(combat_result)
                    popup.hide()

    def _apply_combat_result(self, combat_result):
        self._needs_map_redraw = True
        # Remove dead units from game
        if hasattr(self.game, 'military_manager'):
            dead = [u for u in self.game.military_manager.units if not getattr(u, 'is_alive', True)]
            for u in dead:
                self.game.military_manager.units.remove(u)
                pos = getattr(u, 'position', None)
                if pos and hasattr(self.game, 'hex_map'):
                    tile = self.game.hex_map.tiles.get(pos)
                    if tile and getattr(tile, 'unit', None) == getattr(u, 'unit_type', ''):
                        tile.unit = None

    def update(self, dt):
        pass

    def draw(self, screen):
        if self._needs_map_redraw:
            self.game.hex_map.draw(screen)
            self._needs_map_redraw = False
