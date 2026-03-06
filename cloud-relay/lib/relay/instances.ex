defmodule Relay.Instances do
  @moduledoc """
  Context for managing TmuxDeck instances.
  """

  import Ecto.Query
  alias Relay.Repo
  alias Relay.Instances.Instance

  def list_instances(account_id) do
    Instance
    |> where(account_id: ^account_id)
    |> order_by(desc: :inserted_at)
    |> Repo.all()
  end

  def get_instance!(id), do: Repo.get!(Instance, id)

  def get_instance_by_instance_id(instance_id) do
    Repo.get_by(Instance, instance_id: instance_id)
  end

  def create(account, name) do
    instance_id = generate_instance_id()
    raw_token = "tdck_" <> Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false)

    changeset =
      %Instance{}
      |> Instance.changeset(%{
        instance_id: instance_id,
        account_id: account.id,
        name: name,
        token_hash: Bcrypt.hash_pwd_salt(raw_token),
        token_prefix: String.slice(raw_token, 0, 12)
      })

    case Repo.insert(changeset) do
      {:ok, instance} -> {:ok, instance, raw_token}
      {:error, changeset} -> {:error, changeset}
    end
  end

  def verify_token(raw_token) when is_binary(raw_token) do
    prefix = String.slice(raw_token, 0, 12)

    case Repo.get_by(Instance, token_prefix: prefix) do
      nil ->
        Bcrypt.no_user_verify()
        {:error, :invalid_token}

      %Instance{revoked_at: %DateTime{}} ->
        {:error, :revoked}

      %Instance{} = instance ->
        if Bcrypt.verify_pass(raw_token, instance.token_hash) do
          {:ok, Repo.preload(instance, :account)}
        else
          {:error, :invalid_token}
        end
    end
  end

  def verify_token(_), do: {:error, :invalid_token}

  def revoke_token(%Instance{} = instance) do
    instance
    |> Instance.revoke_changeset()
    |> Repo.update()
  end

  def regenerate_token(%Instance{} = instance) do
    raw_token = "tdck_" <> Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false)

    instance
    |> Ecto.Changeset.change(%{
      token_hash: Bcrypt.hash_pwd_salt(raw_token),
      token_prefix: String.slice(raw_token, 0, 12),
      revoked_at: nil
    })
    |> Repo.update()
    |> case do
      {:ok, instance} -> {:ok, instance, raw_token}
      error -> error
    end
  end

  def mark_online(%Instance{} = instance) do
    {:ok, instance} =
      instance
      |> Instance.status_changeset(%{
        status: "online",
        last_seen_at: DateTime.utc_now(:second),
        relay_node: to_string(node())
      })
      |> Repo.update()

    Phoenix.PubSub.broadcast(
      Relay.PubSub,
      "account:#{instance.account_id}",
      {:instance_status, instance.id, "online"}
    )

    {:ok, instance}
  end

  def mark_offline(%Instance{} = instance) do
    {:ok, instance} =
      instance
      |> Instance.status_changeset(%{
        status: "offline",
        last_seen_at: DateTime.utc_now(:second),
        relay_node: nil
      })
      |> Repo.update()

    Phoenix.PubSub.broadcast(
      Relay.PubSub,
      "account:#{instance.account_id}",
      {:instance_status, instance.id, "offline"}
    )

    {:ok, instance}
  end

  def delete_instance(%Instance{} = instance) do
    Repo.delete(instance)
  end

  defp generate_instance_id do
    :crypto.strong_rand_bytes(4) |> Base.hex_encode32(case: :lower, padding: false) |> String.slice(0, 7)
  end
end
