defmodule RelayWeb.AccountSessionControllerTest do
  use RelayWeb.ConnCase, async: true

  import Relay.AccountsFixtures
  alias Relay.Accounts

  setup do
    %{unconfirmed_account: unconfirmed_account_fixture(), account: account_fixture()}
  end

  describe "GET /accounts/log-in" do
    test "renders login page", %{conn: conn} do
      conn = get(conn, ~p"/accounts/log-in")
      response = html_response(conn, 200)
      assert response =~ "Log in"
      assert response =~ ~p"/accounts/register"
      assert response =~ "Log in with email"
    end

    test "renders login page with email filled in (sudo mode)", %{conn: conn, account: account} do
      html =
        conn
        |> log_in_account(account)
        |> get(~p"/accounts/log-in")
        |> html_response(200)

      assert html =~ "You need to reauthenticate"
      refute html =~ "Register"
      assert html =~ "Log in with email"

      assert html =~
               ~s(<input type="email" name="account[email]" id="login_form_magic_email" value="#{account.email}")
    end

    test "renders login page (email + password)", %{conn: conn} do
      conn = get(conn, ~p"/accounts/log-in?mode=password")
      response = html_response(conn, 200)
      assert response =~ "Log in"
      assert response =~ ~p"/accounts/register"
      assert response =~ "Log in with email"
    end
  end

  describe "GET /accounts/log-in/:token" do
    test "renders confirmation page for unconfirmed account", %{conn: conn, unconfirmed_account: account} do
      token =
        extract_account_token(fn url ->
          Accounts.deliver_login_instructions(account, url)
        end)

      conn = get(conn, ~p"/accounts/log-in/#{token}")
      assert html_response(conn, 200) =~ "Confirm and stay logged in"
    end

    test "renders login page for confirmed account", %{conn: conn, account: account} do
      token =
        extract_account_token(fn url ->
          Accounts.deliver_login_instructions(account, url)
        end)

      conn = get(conn, ~p"/accounts/log-in/#{token}")
      html = html_response(conn, 200)
      refute html =~ "Confirm my account"
      assert html =~ "Log in"
    end

    test "raises error for invalid token", %{conn: conn} do
      conn = get(conn, ~p"/accounts/log-in/invalid-token")
      assert redirected_to(conn) == ~p"/accounts/log-in"

      assert Phoenix.Flash.get(conn.assigns.flash, :error) ==
               "Magic link is invalid or it has expired."
    end
  end

  describe "POST /accounts/log-in - email and password" do
    test "logs the account in", %{conn: conn, account: account} do
      account = set_password(account)

      conn =
        post(conn, ~p"/accounts/log-in", %{
          "account" => %{"email" => account.email, "password" => valid_account_password()}
        })

      assert get_session(conn, :account_token)
      assert redirected_to(conn) == ~p"/"

      # Now do a logged in request and assert on the menu
      conn = get(conn, ~p"/")
      response = html_response(conn, 200)
      assert response =~ account.email
      assert response =~ ~p"/accounts/settings"
      assert response =~ ~p"/accounts/log-out"
    end

    test "logs the account in with remember me", %{conn: conn, account: account} do
      account = set_password(account)

      conn =
        post(conn, ~p"/accounts/log-in", %{
          "account" => %{
            "email" => account.email,
            "password" => valid_account_password(),
            "remember_me" => "true"
          }
        })

      assert conn.resp_cookies["_relay_web_account_remember_me"]
      assert redirected_to(conn) == ~p"/"
    end

    test "logs the account in with return to", %{conn: conn, account: account} do
      account = set_password(account)

      conn =
        conn
        |> init_test_session(account_return_to: "/foo/bar")
        |> post(~p"/accounts/log-in", %{
          "account" => %{
            "email" => account.email,
            "password" => valid_account_password()
          }
        })

      assert redirected_to(conn) == "/foo/bar"
      assert Phoenix.Flash.get(conn.assigns.flash, :info) =~ "Welcome back!"
    end

    test "emits error message with invalid credentials", %{conn: conn, account: account} do
      conn =
        post(conn, ~p"/accounts/log-in?mode=password", %{
          "account" => %{"email" => account.email, "password" => "invalid_password"}
        })

      response = html_response(conn, 200)
      assert response =~ "Log in"
      assert response =~ "Invalid email or password"
    end
  end

  describe "POST /accounts/log-in - magic link" do
    test "sends magic link email when account exists", %{conn: conn, account: account} do
      conn =
        post(conn, ~p"/accounts/log-in", %{
          "account" => %{"email" => account.email}
        })

      assert Phoenix.Flash.get(conn.assigns.flash, :info) =~ "If your email is in our system"
      assert Relay.Repo.get_by!(Accounts.AccountToken, account_id: account.id).context == "login"
    end

    test "logs the account in", %{conn: conn, account: account} do
      {token, _hashed_token} = generate_account_magic_link_token(account)

      conn =
        post(conn, ~p"/accounts/log-in", %{
          "account" => %{"token" => token}
        })

      assert get_session(conn, :account_token)
      assert redirected_to(conn) == ~p"/"

      # Now do a logged in request and assert on the menu
      conn = get(conn, ~p"/")
      response = html_response(conn, 200)
      assert response =~ account.email
      assert response =~ ~p"/accounts/settings"
      assert response =~ ~p"/accounts/log-out"
    end

    test "confirms unconfirmed account", %{conn: conn, unconfirmed_account: account} do
      {token, _hashed_token} = generate_account_magic_link_token(account)
      refute account.confirmed_at

      conn =
        post(conn, ~p"/accounts/log-in", %{
          "account" => %{"token" => token},
          "_action" => "confirmed"
        })

      assert get_session(conn, :account_token)
      assert redirected_to(conn) == ~p"/"
      assert Phoenix.Flash.get(conn.assigns.flash, :info) =~ "Account confirmed successfully."

      assert Accounts.get_account!(account.id).confirmed_at

      # Now do a logged in request and assert on the menu
      conn = get(conn, ~p"/")
      response = html_response(conn, 200)
      assert response =~ account.email
      assert response =~ ~p"/accounts/settings"
      assert response =~ ~p"/accounts/log-out"
    end

    test "emits error message when magic link is invalid", %{conn: conn} do
      conn =
        post(conn, ~p"/accounts/log-in", %{
          "account" => %{"token" => "invalid"}
        })

      assert html_response(conn, 200) =~ "The link is invalid or it has expired."
    end
  end

  describe "DELETE /accounts/log-out" do
    test "logs the account out", %{conn: conn, account: account} do
      conn = conn |> log_in_account(account) |> delete(~p"/accounts/log-out")
      assert redirected_to(conn) == ~p"/"
      refute get_session(conn, :account_token)
      assert Phoenix.Flash.get(conn.assigns.flash, :info) =~ "Logged out successfully"
    end

    test "succeeds even if the account is not logged in", %{conn: conn} do
      conn = delete(conn, ~p"/accounts/log-out")
      assert redirected_to(conn) == ~p"/"
      refute get_session(conn, :account_token)
      assert Phoenix.Flash.get(conn.assigns.flash, :info) =~ "Logged out successfully"
    end
  end
end
