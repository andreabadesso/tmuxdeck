defmodule RelayWeb.AccountSettingsController do
  use RelayWeb, :controller

  alias Relay.Accounts
  alias RelayWeb.AccountAuth

  import RelayWeb.AccountAuth, only: [require_sudo_mode: 2]

  plug :require_sudo_mode
  plug :assign_email_and_password_changesets

  def edit(conn, _params) do
    render(conn, :edit)
  end

  def update(conn, %{"action" => "update_email"} = params) do
    %{"account" => account_params} = params
    account = conn.assigns.current_scope.account

    case Accounts.change_account_email(account, account_params) do
      %{valid?: true} = changeset ->
        Accounts.deliver_account_update_email_instructions(
          Ecto.Changeset.apply_action!(changeset, :insert),
          account.email,
          &url(~p"/accounts/settings/confirm-email/#{&1}")
        )

        conn
        |> put_flash(
          :info,
          "A link to confirm your email change has been sent to the new address."
        )
        |> redirect(to: ~p"/accounts/settings")

      changeset ->
        render(conn, :edit, email_changeset: %{changeset | action: :insert})
    end
  end

  def update(conn, %{"action" => "update_password"} = params) do
    %{"account" => account_params} = params
    account = conn.assigns.current_scope.account

    case Accounts.update_account_password(account, account_params) do
      {:ok, {account, _}} ->
        conn
        |> put_flash(:info, "Password updated successfully.")
        |> put_session(:account_return_to, ~p"/accounts/settings")
        |> AccountAuth.log_in_account(account)

      {:error, changeset} ->
        render(conn, :edit, password_changeset: changeset)
    end
  end

  def confirm_email(conn, %{"token" => token}) do
    case Accounts.update_account_email(conn.assigns.current_scope.account, token) do
      {:ok, _account} ->
        conn
        |> put_flash(:info, "Email changed successfully.")
        |> redirect(to: ~p"/accounts/settings")

      {:error, _} ->
        conn
        |> put_flash(:error, "Email change link is invalid or it has expired.")
        |> redirect(to: ~p"/accounts/settings")
    end
  end

  defp assign_email_and_password_changesets(conn, _opts) do
    account = conn.assigns.current_scope.account

    conn
    |> assign(:email_changeset, Accounts.change_account_email(account))
    |> assign(:password_changeset, Accounts.change_account_password(account))
  end
end
