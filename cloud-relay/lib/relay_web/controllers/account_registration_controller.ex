defmodule RelayWeb.AccountRegistrationController do
  use RelayWeb, :controller

  alias Relay.Accounts
  alias Relay.Accounts.Account

  def new(conn, _params) do
    changeset = Accounts.change_account_email(%Account{})
    render(conn, :new, changeset: changeset)
  end

  def create(conn, %{"account" => account_params}) do
    case Accounts.register_account(account_params) do
      {:ok, account} ->
        {:ok, _} =
          Accounts.deliver_login_instructions(
            account,
            &url(~p"/accounts/log-in/#{&1}")
          )

        conn
        |> put_flash(
          :info,
          "An email was sent to #{account.email}, please access it to confirm your account."
        )
        |> redirect(to: ~p"/accounts/log-in")

      {:error, %Ecto.Changeset{} = changeset} ->
        render(conn, :new, changeset: changeset)
    end
  end
end
