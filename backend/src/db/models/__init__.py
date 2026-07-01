"""ORM model registry. Importing this package registers every model class with
`Base.metadata` so Alembic autogenerate sees the full schema. Empty in the
foundation phase — auth, token-quota, and admin models land here later.
"""
