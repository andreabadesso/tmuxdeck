defmodule Relay.Accounts.Scope do
  @moduledoc """
  Defines the scope of the caller to be used throughout the app.

  The `Relay.Accounts.Scope` allows public interfaces to receive
  information about the caller, such as if the call is initiated from an
  end-user, and if so, which user. Additionally, such a scope can carry fields
  such as "super user" or other privileges for use as authorization, or to
  ensure specific code paths can only be access for a given scope.

  It is useful for logging as well as for scoping pubsub subscriptions and
  broadcasts when a caller subscribes to an interface or performs a particular
  action.

  Feel free to extend the fields on this struct to fit the needs of
  growing application requirements.
  """

  alias Relay.Accounts.Account

  defstruct account: nil

  @doc """
  Creates a scope for the given account.

  Returns nil if no account is given.
  """
  def for_account(%Account{} = account) do
    %__MODULE__{account: account}
  end

  def for_account(nil), do: nil
end
