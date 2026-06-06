<template>
  <p><strong>Current route = </strong>{{ $route.fullPath }}</p>
  <nav>
    <router-link to="/">Home</router-link>
    <router-link to="/about">About Us</router-link>
    <router-link to="/non-existent-path">Broken Link</router-link>
    <router-link to="/login" class="nav-right">Log in</router-link>
    <router-link to="/signup">Sign up</router-link>
  </nav>
  <main class="main-container">
    <router-view />
  </main>
</template>
<style scoped>
main {
  margin: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  margin-bottom: 10px;
  padding: 10px;
  background-color: #b7cece;
}
nav {
  margin: 0;
  display: flex;
  justify-content: left;
  align-items: stretch;
  background-color: #1c0f13;

  & > a {
    padding: 8px;
    text-decoration: none;
    color: #bbbac6;
    cursor: pointer;

    &:hover,
    &:focus {
      background-color: #6e7e85;
    }
  }

  & > .nav-right {
    margin-left: auto;
  }
}
</style>
