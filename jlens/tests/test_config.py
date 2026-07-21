import importlib
def test_layers_env_parse(monkeypatch):
    monkeypatch.setenv("JLENS_LAYERS", "3, 1,3")
    from jlens_service import config
    importlib.reload(config)
    assert config.layers() == [1, 3]
