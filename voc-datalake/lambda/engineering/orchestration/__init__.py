"""Agent orchestration from templates: voc-datalake/templates/orchestration/ compiled into one bundle (7.50.00).

- ``schema.py``: where the sources are, how they are read, their JSON Schemas;
- ``compile.py``: the sources into ``bundle.json`` (voc-skill/1 records, voc-workflow/2 flows, seed bodies), and
  into a Kiro CLI agent config per launchable role (``kiro-agents/``, 7.53.00 prep);
- ``validate.py``: every check ``npm run orchestration:validate`` makes, the drift of the bundle and of the Kiro
  agent configs included;
- ``assertions.py``: the closed vocabulary of step assertions, evaluated on recorded outputs;
- ``bundle.py``: the compiled bundle as the platform reads it (the standard library only);
- ``runner.py``: ``npm run orchestration:run`` (a dry run, or the local fake runtime with scripted models);
- ``calibrate.py``: ``npm run orchestration:calibrate`` (caps and budgets from a run's manifest).

``python -m engineering.orchestration`` (from voc-datalake/lambda) is the command line of all four.
"""
