defmodule RelayWeb.AccountRegistrationController do
  use RelayWeb, :controller

  alias Relay.Accounts
  alias Relay.Accounts.Account
  alias RelayWeb.AccountAuth

  def new(conn, _params) do
    changeset = Accounts.change_account_registration(%Account{})
    render(conn, :new, changeset: changeset)
  end

  def create(conn, %{"account" => account_params}) do
    case Accounts.register_account(account_params) do
      {:ok, account} ->
        conn
        |> put_flash(:info, "Account created successfully.")
        |> AccountAuth.log_in_account(account, account_params)

      {:error, %Ecto.Changeset{} = changeset} ->
        render(conn, :new, changeset: changeset)
    end
  end
end
