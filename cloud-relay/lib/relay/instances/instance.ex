defmodule Relay.Instances.Instance do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id
  schema "instances" do
    field :instance_id, :string
    field :name, :string
    field :token_hash, :string, redact: true
    field :token_prefix, :string
    field :status, :string, default: "offline"
    field :last_seen_at, :utc_datetime
    field :relay_node, :string
    field :revoked_at, :utc_datetime
    field :metadata, :map, default: %{}

    belongs_to :account, Relay.Accounts.Account

    timestamps(type: :utc_datetime)
  end

  def changeset(instance, attrs) do
    instance
    |> cast(attrs, [:name, :instance_id, :token_hash, :token_prefix, :account_id])
    |> validate_required([:name, :instance_id, :token_hash, :token_prefix, :account_id])
    |> validate_length(:name, min: 1, max: 100)
    |> unique_constraint(:instance_id)
  end

  def status_changeset(instance, attrs) do
    instance
    |> cast(attrs, [:status, :last_seen_at, :relay_node, :metadata])
  end

  def revoke_changeset(instance) do
    change(instance, revoked_at: DateTime.utc_now(:second))
  end
end
