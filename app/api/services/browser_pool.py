"""
BrowserPool — pool d'instances Chrome/DrissionPage avec acquisition *prioritaire*.

Problème résolu : un job de download Sushiscan tenait un unique lock global pendant
toute sa durée (minutes), bloquant toute recherche d'un autre utilisateur.

Solution :
  • N navigateurs (SUSHISCAN_POOL_SIZE, défaut 2) → parallélisme réel.
  • Acquisition par PRIORITÉ : une recherche (interactive) passe devant un download.
  • Les downloads prennent un bail *par chapitre* et le relâchent entre chaque →
    même avec pool=1, une recherche en attente s'intercale après le chapitre courant.
  • Health-check + respawn des navigateurs morts.

Le pool ne crée jamais plus de `size` navigateurs (chaque permit == un slot).
La création (lente, plusieurs secondes) se fait HORS du lock pour ne bloquer personne.
"""
from __future__ import annotations

import heapq
import itertools
import threading
import time
from contextlib import contextmanager
from typing import Callable, Iterator

# Priorités : plus petit = servi en premier
PRIO_SEARCH = 0     # recherche / chapitres / meta / image — interactif
PRIO_DOWNLOAD = 10  # job de fond


class BrowserPool:
    def __init__(self, size: int, factory: Callable[[], object],
                 name: str = "sushiscan", idle_timeout: float = 0):
        self.size = max(1, int(size))
        self._factory = factory
        self._name = name
        self._idle_timeout = float(idle_timeout)  # 0 = jamais de fermeture auto
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self._idle: list[tuple] = []     # (navigateur, released_at) prêts à l'emploi
        self._permits = self.size        # slots de concurrence disponibles
        self._waiters: list[tuple] = []  # heap de tickets (priority, seq)
        self._seq = itertools.count()
        if self._idle_timeout > 0:
            t = threading.Thread(target=self._reap_loop, name=f"{name}-reaper", daemon=True)
            t.start()

    # ── permits (priorité) ────────────────────────────────────────────────────

    def _acquire_permit(self, priority: int, timeout: float | None) -> None:
        deadline = None if timeout is None else time.monotonic() + timeout
        with self._cond:
            ticket = (priority, next(self._seq))
            heapq.heappush(self._waiters, ticket)
            self._cond.notify_all()
            try:
                while True:
                    # Servi si je suis en tête du heap (plus haute priorité) et qu'un slot est libre
                    if self._waiters and self._waiters[0] == ticket and self._permits > 0:
                        self._permits -= 1
                        heapq.heappop(self._waiters)
                        self._cond.notify_all()
                        return
                    remaining = None if deadline is None else deadline - time.monotonic()
                    if remaining is not None and remaining <= 0:
                        raise TimeoutError(f"{self._name}: aucun navigateur libre (timeout)")
                    self._cond.wait(remaining)
            finally:
                # Nettoyage du ticket en cas de timeout/exception
                if ticket in self._waiters:
                    self._waiters.remove(ticket)
                    heapq.heapify(self._waiters)
                    self._cond.notify_all()

    def _release_permit(self) -> None:
        with self._cond:
            self._permits += 1
            self._cond.notify_all()

    # ── navigateurs ───────────────────────────────────────────────────────────

    @staticmethod
    def _is_alive(drv) -> bool:
        # DrissionPage 4.x : states.is_alive est fiable (current_tab n'existe pas)
        try:
            return bool(drv.states.is_alive)
        except Exception:
            pass
        try:
            _ = drv.tab_id
            return True
        except Exception:
            return False

    @staticmethod
    def _safe_close(drv) -> None:
        for meth in ("quit", "close"):
            try:
                getattr(drv, meth)()
                return
            except Exception:
                continue

    def _get_browser(self):
        """Appelé APRÈS avoir un permit. Réutilise un idle sain ou en crée un (hors lock)."""
        with self._lock:
            drv = self._idle.pop()[0] if self._idle else None
        if drv is not None:
            if self._is_alive(drv):
                return drv
            self._safe_close(drv)  # mort → on jette et on recrée
        return self._factory()     # création lente, hors lock

    def _put_browser(self, drv) -> None:
        with self._lock:
            self._idle.append((drv, time.monotonic()))  # horodatage pour le reaper

    # ── API publique ──────────────────────────────────────────────────────────

    @contextmanager
    def lease(self, priority: int = PRIO_DOWNLOAD, timeout: float | None = None) -> Iterator[object]:
        """Contexte : fournit un navigateur, le rend au pool à la sortie."""
        self._acquire_permit(priority, timeout)
        drv = None
        try:
            drv = self._get_browser()
            yield drv
        finally:
            if drv is not None:
                if self._is_alive(drv):
                    self._put_browser(drv)
                else:
                    self._safe_close(drv)
            self._release_permit()

    def shutdown(self) -> None:
        """Ferme les navigateurs inactifs (libère la RAM). N'affecte pas les baux en cours."""
        with self._lock:
            idle = [drv for drv, _ in self._idle]
            self._idle = []
        for drv in idle:
            self._safe_close(drv)

    # ── reaper : ferme les navigateurs inactifs depuis trop longtemps ──────────

    def _reap_loop(self) -> None:
        # Réveil régulier ; ferme uniquement les IDLE trop vieux. Ne touche jamais
        # un navigateur baillé (il n'est pas dans _idle). Réutilisation à chaud intacte.
        interval = min(self._idle_timeout, 60.0)
        while True:
            time.sleep(interval)
            now = time.monotonic()
            with self._lock:
                keep, expired = [], []
                for drv, released_at in self._idle:
                    (expired if now - released_at >= self._idle_timeout else keep).append(drv)
                self._idle = [(d, r) for d, r in self._idle if d in keep]
            for drv in expired:
                self._safe_close(drv)
            if expired:
                print(f"[{self._name}] reaper: {len(expired)} navigateur(s) inactif(s) fermé(s)", flush=True)

    def stats(self) -> dict:
        with self._lock:
            return {
                "size": self.size,
                "idle": len(self._idle),
                "permits_free": self._permits,
                "waiting": len(self._waiters),
                "idle_timeout": self._idle_timeout,
            }
