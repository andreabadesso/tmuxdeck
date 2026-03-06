defmodule Relay.Repo.Migrations.CreateInstances do
  use Ecto.Migration

  def change do
    create table(:instances, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :account_id, references(:accounts, type: :binary_id, on_delete: :delete_all), null: false
      add :instance_id, :string, null: false
      add :name, :string, null: false
      add :token_hash, :string, null: false
      add :token_prefix, :string, null: false
      add :status, :string, null: false, default: "offline"
      add :last_seen_at, :utc_datetime
      add :relay_node, :string
      add :revoked_at, :utc_datetime
      add :metadata, :map, default: %{}

      timestamps(type: :utc_datetime)
    end

    create unique_index(:instances, [:instance_id])
    create index(:instances, [:account_id])
    create index(:instances, [:token_prefix])
  end
end
